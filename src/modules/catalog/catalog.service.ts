import mongoose from 'mongoose';
import User from '../users/user.model.js';
import CatalogArtist, { type ICatalogArtist } from './catalog-artist.model.js';
import CatalogSubmissionLog from './catalog-submission-log.model.js';
import CatalogAlbum, { type ICatalogAlbum } from './catalog-album.model.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { artistKey } from '../artists/artist.service.js';
import { isCatalogImageUrl } from '../uploads/uploads.service.js';
import { stripHtml } from '../../utils/sanitize.js';
import { hasPermission } from '../../shared/permissions.js';
import type { CatalogSource } from './catalog.types.js';

export type CatalogErrorCode =
  | 'CATALOG_UNVERIFIED'
  | 'CATALOG_RATE_LIMITED'
  | 'CATALOG_PENDING_CAP'
  | 'CATALOG_DUPLICATE'
  | 'CATALOG_PARENT_NOT_APPROVED'
  | 'CATALOG_INVALID_IMAGE'
  | 'CATALOG_INVALID_INPUT'
  | 'CATALOG_NOT_FOUND'
  | 'CATALOG_FORBIDDEN'
  | 'CATALOG_SELF_REVIEW'
  | 'CATALOG_ALREADY_REVIEWED'
  | 'CATALOG_CHANGED'
  | 'CATALOG_DISAMBIGUATION_REQUIRED'
  | 'CATALOG_GENIUS_UNAVAILABLE'
  | 'CATALOG_GENIUS_UPSTREAM'
  | 'CATALOG_GENIUS_NOT_FOUND'
  | 'CATALOG_GENIUS_IMAGE_REJECTED';

/** `existing` is set only for approved entries or the caller's own pending one. */
export type CatalogError = {
  error: string;
  status: number;
  code: CatalogErrorCode;
  existing?: { id: string; name: string; slug: string | null };
};

export type ArtistInput = { name: string; bio?: string; imageUrl?: string | null };
export type AlbumInput = { artistId: string; title: string; year?: string | null; coverUrl?: string | null };
export type ArtistPatch = Partial<ArtistInput>;
export type AlbumPatch = Partial<Omit<AlbumInput, 'artistId'>>;

export const fail = (status: number, code: CatalogErrorCode, error: string, existing?: CatalogError['existing']): CatalogError => ({
  error,
  status,
  code,
  ...(existing ? { existing } : {}),
});
export const invalid = (error: string): CatalogError => fail(400, 'CATALOG_INVALID_INPUT', error);
export const notFound = (): CatalogError => fail(404, 'CATALOG_NOT_FOUND', 'Entry not found');

export const isError = (v: unknown): v is CatalogError => typeof v === 'object' && v !== null && 'code' in v && 'error' in v;
export const validId = (id: unknown): id is string => typeof id === 'string' && mongoose.isValidObjectId(id);
export const oid = (id: string) => new mongoose.Types.ObjectId(id);
export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function cleanName(raw: unknown, max: number, label: string): string | CatalogError {
  if (typeof raw !== 'string') return invalid(`${label} is required`);
  const v = squash(stripHtml(raw)).normalize('NFC');
  if (!v) return invalid(`${label} is required`);
  if (v.length > max) return invalid(`${label} must be at most ${max} characters`);
  return v;
}

export function cleanBio(raw: unknown): string | CatalogError {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return invalid('Bio must be text');
  // Sanitize first, then measure: markup must not count against the cap.
  const v = stripHtml(raw);
  if (v.length > CATALOG_LIMITS.maxBio) return invalid(`Bio must be at most ${CATALOG_LIMITS.maxBio} characters`);
  return v;
}

export function cleanYear(raw: unknown): string | null | CatalogError {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return invalid('Year must be text');
  const v = raw.trim();
  if (!/^\d{4}$/.test(v)) return invalid('Year must be four digits');
  return v;
}

/** Community users may only reference images they uploaded themselves. */
function cleanImage(raw: unknown, userId: string): string | null | CatalogError {
  if (raw === undefined || raw === null) return null;
  if (!isCatalogImageUrl(raw, userId)) return fail(422, 'CATALOG_INVALID_IMAGE', 'Image must be uploaded through the catalog uploader');
  return raw;
}

// Serializes check + insert per user so two simultaneous submissions cannot both pass the caps.
// Valid only because production runs a single instance (same constraint as the other in-memory
// stores in .claude/rules/technical-debt.md); move to an atomic counter before scaling horizontally.
const userLocks = new Map<string, Promise<unknown>>();
async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  userLocks.set(userId, tail);
  try {
    return await run;
  } finally {
    if (userLocks.get(userId) === tail) userLocks.delete(userId);
  }
}

async function logSubmission(userId: string): Promise<void> {
  await CatalogSubmissionLog.create({ userId: oid(userId), at: new Date() });
}

/** One user read: gates the caps and decides the entry's source (staff submissions are 'admin'). */
async function assertCanSubmit(userId: string): Promise<{ blocked: CatalogError } | { source: CatalogSource }> {
  const user = await User.findById(userId).select('isVerified permissions').lean();
  if (!user?.isVerified) return { blocked: fail(403, 'CATALOG_UNVERIFIED', 'Verify your email to submit to the catalog') };
  const submittedBy = oid(userId);
  const since = new Date(Date.now() - CATALOG_LIMITS.windowMs);
  // The day window counts the submission log, not live docs, so withdrawing cannot reset it.
  const [day, pendA, pendB] = await Promise.all([
    CatalogSubmissionLog.countDocuments({ userId: submittedBy, at: { $gte: since } }),
    CatalogArtist.countDocuments({ submittedBy, status: 'pending' }),
    CatalogAlbum.countDocuments({ submittedBy, status: 'pending' }),
  ]);
  if (day >= CATALOG_LIMITS.maxPerDay) return { blocked: fail(429, 'CATALOG_RATE_LIMITED', 'Too many submissions in the last 24 hours') };
  if (pendA + pendB >= CATALOG_LIMITS.maxPending) return { blocked: fail(429, 'CATALOG_PENDING_CAP', 'Too many pending submissions') };
  return { source: hasPermission(user.permissions, 'catalog.manage') ? 'admin' : 'community' };
}

type Dupable = { _id: unknown; slug: string | null; status: string; submittedBy: unknown };
function duplicateOf(userId: string, hit: Dupable | null, name: string): CatalogError | null {
  if (!hit) return null;
  const reveal = hit.status === 'approved' || String(hit.submittedBy) === userId;
  return fail(409, 'CATALOG_DUPLICATE', 'This entry already exists', reveal ? { id: String(hit._id), name, slug: hit.slug } : undefined);
}

async function findArtistDuplicate(userId: string, nameKey: string, excludeId?: string): Promise<CatalogError | null> {
  const base = { nameKey, ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}) };
  // Approved first so a visible entry is preferred over someone else's pending one.
  const hit =
    (await CatalogArtist.findOne({ ...base, status: 'approved' }).lean()) ??
    (await CatalogArtist.findOne({ ...base, status: 'pending', submittedBy: oid(userId) }).lean()) ??
    (await CatalogArtist.findOne({ ...base, status: 'pending' }).sort({ createdAt: 1 }).lean());
  return duplicateOf(userId, hit, hit?.name ?? '');
}

async function findAlbumDuplicate(userId: string, artistId: mongoose.Types.ObjectId, titleKey: string, excludeId?: string): Promise<CatalogError | null> {
  const base = { artistId, titleKey, ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}) };
  const hit =
    (await CatalogAlbum.findOne({ ...base, status: 'approved' }).lean()) ??
    (await CatalogAlbum.findOne({ ...base, status: 'pending', submittedBy: oid(userId) }).lean()) ??
    (await CatalogAlbum.findOne({ ...base, status: 'pending' }).sort({ createdAt: 1 }).lean());
  return duplicateOf(userId, hit, hit?.title ?? '');
}

export const albumKey = (title: string): string => artistKey(title.trim());

export async function submitCatalogArtist(userId: string, input: ArtistInput): Promise<{ artist: ICatalogArtist } | CatalogError> {
  const name = cleanName(input?.name, CATALOG_LIMITS.maxArtistName, 'Name');
  if (isError(name)) return name;
  const bio = cleanBio(input.bio);
  if (isError(bio)) return bio;
  const imageUrl = cleanImage(input.imageUrl, userId);
  if (isError(imageUrl)) return imageUrl;

  return withUserLock(userId, async () => {
    const gate = await assertCanSubmit(userId);
    if ('blocked' in gate) return gate.blocked;
    const nameKey = artistKey(name);
    const dup = await findArtistDuplicate(userId, nameKey);
    if (dup) return dup;

    const artist = await CatalogArtist.create({
      name, nameKey, bio, imageUrl, slug: null, status: 'pending', source: gate.source, submittedBy: oid(userId),
    });
    await logSubmission(userId);
    return { artist };
  });
}

export async function submitCatalogAlbum(userId: string, input: AlbumInput): Promise<{ album: ICatalogAlbum } | CatalogError> {
  const title = cleanName(input?.title, CATALOG_LIMITS.maxAlbumTitle, 'Title');
  if (isError(title)) return title;
  const year = cleanYear(input.year);
  if (isError(year)) return year;
  const coverUrl = cleanImage(input.coverUrl, userId);
  if (isError(coverUrl)) return coverUrl;

  return withUserLock(userId, () => createAlbum(userId, input, title, year, coverUrl));
}

async function createAlbum(
  userId: string,
  input: AlbumInput,
  title: string,
  year: string | null,
  coverUrl: string | null,
): Promise<{ album: ICatalogAlbum } | CatalogError> {
  const gate = await assertCanSubmit(userId);
  if ('blocked' in gate) return gate.blocked;
  const parentError = fail(422, 'CATALOG_PARENT_NOT_APPROVED', 'The artist must be approved first');
  if (!validId(input.artistId)) return parentError;
  const parent = await CatalogArtist.findOne({ _id: oid(input.artistId), status: 'approved' }).select('_id').lean();
  if (!parent) return parentError;

  const titleKey = albumKey(title);
  const dup = await findAlbumDuplicate(userId, parent._id, titleKey);
  if (dup) return dup;

  const album = await CatalogAlbum.create({
    artistId: parent._id, title, titleKey, year, coverUrl, slug: null, status: 'pending', source: gate.source, submittedBy: oid(userId),
  });
  await logSubmission(userId);
  return { album };
}

export async function updateMyPendingEntry(userId: string, kind: 'artist', id: string, patch: ArtistPatch): Promise<{ artist: ICatalogArtist } | CatalogError>;
export async function updateMyPendingEntry(userId: string, kind: 'album', id: string, patch: AlbumPatch): Promise<{ album: ICatalogAlbum } | CatalogError>;
export async function updateMyPendingEntry(
  userId: string,
  kind: 'artist' | 'album',
  id: string,
  patch: ArtistPatch | AlbumPatch,
): Promise<{ artist: ICatalogArtist } | { album: ICatalogAlbum } | CatalogError> {
  if (!validId(id)) return notFound();
  const filter = { _id: oid(id), submittedBy: oid(userId), status: 'pending' as const };
  const set: Record<string, unknown> = {};

  if (kind === 'artist') {
    const p = patch as ArtistPatch;
    const current = await CatalogArtist.findOne(filter).lean();
    if (!current) return notFound();
    if (p.name !== undefined) {
      const name = cleanName(p.name, CATALOG_LIMITS.maxArtistName, 'Name');
      if (isError(name)) return name;
      const nameKey = artistKey(name);
      const dup = await findArtistDuplicate(userId, nameKey, id);
      if (dup) return dup;
      Object.assign(set, { name, nameKey });
    }
    if (p.bio !== undefined) {
      const bio = cleanBio(p.bio);
      if (isError(bio)) return bio;
      set.bio = bio;
    }
    if (p.imageUrl !== undefined) {
      const imageUrl = cleanImage(p.imageUrl, userId);
      if (isError(imageUrl)) return imageUrl;
      set.imageUrl = imageUrl;
    }
    // The status filter repeats so a review landing between read and write cannot be overwritten.
    const artist = await CatalogArtist.findOneAndUpdate(filter, { $set: set }, { returnDocument: 'after' });
    return artist ? { artist } : notFound();
  }

  const p = patch as AlbumPatch;
  const current = await CatalogAlbum.findOne(filter).lean();
  if (!current) return notFound();
  if (p.title !== undefined) {
    const title = cleanName(p.title, CATALOG_LIMITS.maxAlbumTitle, 'Title');
    if (isError(title)) return title;
    const titleKey = albumKey(title);
    const dup = await findAlbumDuplicate(userId, current.artistId, titleKey, id);
    if (dup) return dup;
    Object.assign(set, { title, titleKey });
  }
  if (p.year !== undefined) {
    const year = cleanYear(p.year);
    if (isError(year)) return year;
    set.year = year;
  }
  if (p.coverUrl !== undefined) {
    const coverUrl = cleanImage(p.coverUrl, userId);
    if (isError(coverUrl)) return coverUrl;
    set.coverUrl = coverUrl;
  }
  const album = await CatalogAlbum.findOneAndUpdate(filter, { $set: set }, { returnDocument: 'after' });
  return album ? { album } : notFound();
}

export async function withdrawMyPendingEntry(userId: string, kind: 'artist' | 'album', id: string): Promise<{ ok: true } | CatalogError> {
  if (!validId(id)) return notFound();
  const filter = { _id: oid(id), submittedBy: oid(userId), status: 'pending' as const };
  const res = kind === 'artist' ? await CatalogArtist.deleteOne(filter) : await CatalogAlbum.deleteOne(filter);
  return res.deletedCount === 1 ? { ok: true } : notFound();
}

export async function listMySubmissions(userId: string): Promise<{ artists: ICatalogArtist[]; albums: ICatalogAlbum[] }> {
  const submittedBy = oid(userId);
  const [artists, albums] = await Promise.all([
    CatalogArtist.find({ submittedBy }).sort({ createdAt: -1, _id: -1 }),
    CatalogAlbum.find({ submittedBy }).sort({ createdAt: -1, _id: -1 }),
  ]);
  return { artists, albums };
}

/**
 * Called after a catalog entry is approved. Step 2 of the catalog fills this
 * with auto-linking of matching user artists; until then it is a no-op.
 */
export async function onCatalogApproved(_kind: 'artist' | 'album', _entry: ICatalogArtist | ICatalogAlbum): Promise<void> {}
