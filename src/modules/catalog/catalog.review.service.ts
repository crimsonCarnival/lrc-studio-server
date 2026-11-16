import mongoose from 'mongoose';
import User from '../users/user.model.js';
import CatalogArtist, { type ICatalogArtist } from './catalog-artist.model.js';
import CatalogAlbum, { type ICatalogAlbum } from './catalog-album.model.js';
import { assignArtistSlug, assignAlbumSlug } from './catalog.slug.js';
import { awardCatalogCredit } from './catalog.rewards.js';
import { notifyCatalogReviewed } from './catalog.notify.js';
import { fail, invalid, notFound, validId, oid, squash, onCatalogApproved, type CatalogError } from './catalog.service.js';
import { triggerBadgeCheck } from '../badges/badge.service.js';
import { hasPermission } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';

const MAX_NOTE = 500;

export type CatalogReviewer = { userId: string; permissions: string[] };
export type ReviewOptions = {
  /** The `updatedAt` the reviewer saw. A later edit makes the review fail with CATALOG_CHANGED. */
  expectedUpdatedAt?: Date | string;
};

const forbidden = (): CatalogError => fail(403, 'CATALOG_FORBIDDEN', 'You cannot review catalog entries');
const logFailure = (what: string, err: unknown): void => console.error(`[catalog] ${what} failed`, err);

type Entry = ICatalogArtist | ICatalogAlbum;
type Claimed = Pick<ICatalogArtist, 'status' | 'submittedBy' | 'source' | 'updatedAt'> & { _id: mongoose.Types.ObjectId };

export async function reviewCatalogEntry(
  reviewer: CatalogReviewer,
  kind: 'artist' | 'album',
  id: string,
  decision: 'approve' | 'reject',
  note?: string,
  opts?: ReviewOptions,
): Promise<{ entry: Entry } | CatalogError> {
  // The passed permissions are only a fast pre-check: the DB copy is authoritative,
  // so a permission revoked after the session loaded it is refused here.
  if (!hasPermission(reviewer.permissions, 'catalog.review')) return forbidden();
  if (!validId(reviewer.userId)) return forbidden();
  const dbUser = await User.findById(reviewer.userId)
    .select('permissions isDeleted ban.active')
    .lean<{ permissions?: string[]; isDeleted?: boolean; ban?: { active?: boolean } }>();
  if (!dbUser || dbUser.isDeleted || dbUser.ban?.active) return forbidden();
  if (!hasPermission(dbUser.permissions, 'catalog.review')) return forbidden();

  if (decision !== 'approve' && decision !== 'reject') return invalid('Unknown decision');
  if (!validId(id)) return notFound();

  let reviewNote = '';
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') return invalid('Note must be text');
    reviewNote = squash(stripHtml(note));
    if (reviewNote.length > MAX_NOTE) return invalid(`Note must be at most ${MAX_NOTE} characters`);
  }

  let expected: Date | undefined;
  if (opts?.expectedUpdatedAt !== undefined) {
    expected = new Date(opts.expectedUpdatedAt);
    if (Number.isNaN(expected.getTime())) return invalid('Invalid expectedUpdatedAt');
  }

  const Model = (kind === 'artist' ? CatalogArtist : CatalogAlbum) as mongoose.Model<ICatalogArtist | ICatalogAlbum>;
  const current = await Model.findById(oid(id)).lean<Claimed & { artistId?: mongoose.Types.ObjectId }>();
  if (!current) return notFound();
  // Self-review needs catalog.manage: those users can already create approved entries directly,
  // so approving their own submission grants no new power. Plain reviewers stay blocked.
  const isOwnSubmission = String(current.submittedBy) === reviewer.userId;
  if (isOwnSubmission && !hasPermission(dbUser.permissions, 'catalog.manage')) {
    return fail(403, 'CATALOG_SELF_REVIEW', 'You cannot review your own submission');
  }
  if (current.status !== 'pending') return fail(409, 'CATALOG_ALREADY_REVIEWED', 'This entry was already reviewed');

  // Checked before the claim so a refusal leaves the album pending and nothing to roll back.
  if (kind === 'album' && decision === 'approve') {
    const parent = await CatalogArtist.exists({ _id: current.artistId, status: 'approved' });
    if (!parent) return fail(422, 'CATALOG_PARENT_NOT_APPROVED', 'The artist must be approved first');
  }

  // Same rule: an approved twin refuses the approval (rejecting stays possible), the entry stays pending.
  if (decision === 'approve') {
    const twin = kind === 'artist'
      ? await CatalogArtist.findOne({ nameKey: (current as unknown as ICatalogArtist).nameKey, status: 'approved' }).select('name slug').lean()
      : await CatalogAlbum.findOne({ artistId: current.artistId, titleKey: (current as unknown as ICatalogAlbum).titleKey, status: 'approved' }).select('title slug').lean();
    if (twin) {
      const name = 'name' in twin ? twin.name : (twin as { title: string }).title;
      return fail(409, 'CATALOG_DUPLICATE', 'This entry already exists', { id: String(twin._id), name, slug: twin.slug });
    }
  }

  const status = decision === 'approve' ? 'approved' : 'rejected';
  const claimed = await Model.findOneAndUpdate(
    { _id: current._id, status: 'pending', ...(expected ? { updatedAt: expected } : {}) },
    { $set: { status, reviewedBy: oid(reviewer.userId), reviewedAt: new Date(), reviewNote } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    // Lost the claim. A still-pending entry means it was edited after the reviewer loaded it.
    const now = await Model.findById(current._id).select('status').lean<{ status: string }>();
    if (now?.status === 'pending') return fail(409, 'CATALOG_CHANGED', 'The entry changed since you opened it');
    return fail(409, 'CATALOG_ALREADY_REVIEWED', 'This entry was already reviewed');
  }

  const submitterId = String(claimed.submittedBy);
  const entryName = kind === 'artist' ? (claimed as ICatalogArtist).name : (claimed as ICatalogAlbum).title;

  if (decision === 'approve') {
    try {
      if (kind === 'artist') await assignArtistSlug(claimed._id as mongoose.Types.ObjectId, (claimed as ICatalogArtist).name);
      else await assignAlbumSlug(claimed._id as mongoose.Types.ObjectId, (claimed as ICatalogAlbum).artistId, (claimed as ICatalogAlbum).title);
    } catch (err) {
      // Approval stands; a slugless approved entry can be retried without redoing the review.
      logFailure('slug assignment', err);
    }
    // No credit for approving your own entry (same as admin-created ones), so it cannot farm XP or badges.
    if (claimed.source === 'community' && !isOwnSubmission) {
      try {
        // Flip first, conditionally: only the call that wins the flip awards, so a retry or
        // backfill can never award twice. A failed award is logged for manual repair.
        const flipped = await Model.updateOne({ _id: claimed._id, creditAwarded: false }, { $set: { creditAwarded: true } });
        if (flipped.modifiedCount === 1) await awardCatalogCredit(submitterId, kind);
      } catch (err) {
        logFailure('credit award', err);
      }
    }
  }

  await User.updateOne({ _id: oid(reviewer.userId) }, { $inc: { 'stats.catalogReviews': 1 } }).catch((err) =>
    logFailure('reviewer counter', err),
  );
  await notifyCatalogReviewed(submitterId, kind, decision, entryName, reviewNote).catch((err) => logFailure('notification', err));

  const entry = (await Model.findById(claimed._id)) ?? claimed;
  if (decision === 'approve') await onCatalogApproved(kind, entry).catch((err) => logFailure('onCatalogApproved', err));

  // The submitter's badge check runs inside awardCatalogCredit, once per awarded credit.
  triggerBadgeCheck(reviewer.userId, 'catalog_review').catch((err) => logFailure('reviewer badge check', err));
  return { entry };
}
