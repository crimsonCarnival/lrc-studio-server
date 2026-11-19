import mongoose from 'mongoose';
import User from '../users/user.model.js';
import CatalogArtist, { type ICatalogArtist } from './catalog-artist.model.js';
import CatalogAlbum, { type ICatalogAlbum } from './catalog-album.model.js';
import { assignArtistSlug, assignAlbumSlug } from './catalog.slug.js';
import { revokeCatalogCredit } from './catalog.rewards.js';
import {
  fail, invalid, notFound, validId, oid, squash, isError, cleanName, cleanBio, cleanYear, albumKey,
  type CatalogError, type ArtistInput, type AlbumInput,
} from './catalog.service.js';
import { importAlbumsFromSongs } from './catalog.import.service.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { CATALOG_IMAGE_SOURCES, type CatalogImageSource } from './catalog.types.js';
import { artistKey } from '../artists/artist.service.js';
import { isCatalogImageUrl } from '../uploads/uploads.service.js';
import { hasPermission } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import { logAdminAction } from '../admin/admin.service.js';

const MAX_DISAMBIGUATION = 80;

export type AdminArtistInput = ArtistInput & {
  disambiguation?: string;
  imageSource?: CatalogImageSource | null;
  imageSourceUrl?: string | null;
};
/** In a patch, `undefined` leaves a field unchanged; `null` on imageUrl/coverUrl clears it. */
export type AdminArtistPatch = Partial<AdminArtistInput>;
export type AdminAlbumPatch = Partial<Omit<AlbumInput, 'artistId'>>;

/**
 * Called after an approved catalog entry is deleted. Step 2 of the catalog fills this
 * with unlinking of songs/shelf artists that pointed at it; until then it is a no-op.
 */
export async function onCatalogDeleted(_kind: 'artist' | 'album', _entryId: string): Promise<void> {}

const logFailure = (what: string, err: unknown): void => console.error(`[catalog] ${what} failed`, err);

// The DB copy is authoritative: a permission revoked, or a ban applied, after the session
// loaded the user is honoured here. Sudo is enforced at the GraphQL layer.
export async function assertManager(adminId: string): Promise<CatalogError | null> {
  const denied = fail(403, 'CATALOG_FORBIDDEN', 'You cannot manage the catalog');
  if (!validId(adminId)) return denied;
  const user = await User.findById(adminId).select('permissions isDeleted ban').lean<{ permissions?: string[]; isDeleted?: boolean; ban?: { active?: boolean } }>();
  if (!user || user.isDeleted || user.ban?.active) return denied;
  return hasPermission(user.permissions, 'catalog.manage') ? null : denied;
}

// Admins may reuse any catalog-folder image, so no uploader binding.
function cleanAdminImage(raw: unknown): string | null | CatalogError {
  if (raw === undefined || raw === null) return null;
  if (!isCatalogImageUrl(raw)) return fail(422, 'CATALOG_INVALID_IMAGE', 'Image must be uploaded through the catalog uploader');
  return raw;
}

/** A canonical Genius page: https, host exactly genius.com, no credentials, port, query or hash. */
export function isGeniusPageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const u = new URL(url);
    return u.href === url && u.protocol === 'https:' && u.hostname === 'genius.com' && !u.username && !u.password && !u.port && !u.search && !u.hash;
  } catch {
    return false;
  }
}

type ImageCredit = { imageSource: CatalogImageSource | null; imageSourceUrl: string | null };

// Applied whenever imageUrl is written: the credit can never outlive or mismatch the photo.
function resolveImageCredit(imageUrl: string | null, source: unknown, sourceUrl: unknown): ImageCredit | CatalogError {
  if (source != null && !(CATALOG_IMAGE_SOURCES as readonly unknown[]).includes(source)) return invalid('Unknown image source');
  if (imageUrl === null) return { imageSource: null, imageSourceUrl: null };
  if (source === 'genius') {
    if (!isGeniusPageUrl(sourceUrl)) return invalid('Image source URL must be a genius.com page');
    return { imageSource: 'genius', imageSourceUrl: sourceUrl };
  }
  return { imageSource: 'upload', imageSourceUrl: null };
}

function cleanDisambiguation(raw: unknown): string | CatalogError {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return invalid('Disambiguation must be text');
  const v = squash(stripHtml(raw)).normalize('NFC');
  if (v.length > MAX_DISAMBIGUATION) return invalid(`Disambiguation must be at most ${MAX_DISAMBIGUATION} characters`);
  return v;
}

const needsDisambiguation = (): CatalogError =>
  fail(422, 'CATALOG_DISAMBIGUATION_REQUIRED', 'An approved artist with this name exists; add a disambiguation');

async function audit(adminId: string, action: 'catalog.create' | 'catalog.update' | 'catalog.delete' | 'catalog.import', id: string, name: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await logAdminAction({ adminId, action, targetId: id, targetName: name, details: JSON.stringify(meta) });
  } catch (err) {
    logFailure('admin log', err);
  }
}

export async function adminCreateCatalogArtist(adminId: string, input: AdminArtistInput): Promise<{ artist: ICatalogArtist } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  if (!input || typeof input !== 'object') return invalid('Input is required');
  const name = cleanName(input.name, CATALOG_LIMITS.maxArtistName, 'Name');
  if (isError(name)) return name;
  const bio = cleanBio(input.bio);
  if (isError(bio)) return bio;
  const imageUrl = cleanAdminImage(input.imageUrl);
  if (isError(imageUrl)) return imageUrl;
  const credit = resolveImageCredit(imageUrl, input.imageSource, input.imageSourceUrl);
  if (isError(credit)) return credit;
  const disambiguation = cleanDisambiguation(input.disambiguation);
  if (isError(disambiguation)) return disambiguation;

  const nameKey = artistKey(name);
  if (!disambiguation && (await CatalogArtist.exists({ nameKey, status: 'approved' }))) return needsDisambiguation();

  const artist = await CatalogArtist.create({
    name, nameKey, bio, imageUrl, ...credit, disambiguation, slug: null, status: 'approved', source: 'admin',
    submittedBy: oid(adminId), reviewedBy: oid(adminId), reviewedAt: new Date(),
  });
  await assignArtistSlug(artist._id, name);
  await audit(adminId, 'catalog.create', String(artist._id), name, { kind: 'artist', name });
  await importAlbumsFromSongs(artist, adminId).catch((err) => logFailure('album import', err));
  return { artist: (await CatalogArtist.findById(artist._id)) ?? artist };
}

export async function adminCreateCatalogAlbum(adminId: string, input: AlbumInput): Promise<{ album: ICatalogAlbum } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  if (!input || typeof input !== 'object') return invalid('Input is required');
  const title = cleanName(input.title, CATALOG_LIMITS.maxAlbumTitle, 'Title');
  if (isError(title)) return title;
  const year = cleanYear(input.year);
  if (isError(year)) return year;
  const coverUrl = cleanAdminImage(input.coverUrl);
  if (isError(coverUrl)) return coverUrl;

  const parentError = fail(422, 'CATALOG_PARENT_NOT_APPROVED', 'The artist must be approved first');
  if (!validId(input.artistId)) return parentError;
  const parent = await CatalogArtist.findOne({ _id: oid(input.artistId), status: 'approved' }).select('_id').lean();
  if (!parent) return parentError;

  const titleKey = albumKey(title);
  const dup = await CatalogAlbum.findOne({ artistId: parent._id, titleKey, status: 'approved' }).select('_id slug').lean();
  if (dup) return fail(409, 'CATALOG_DUPLICATE', 'This album already exists', { id: String(dup._id), name: title, slug: dup.slug });

  const album = await CatalogAlbum.create({
    artistId: parent._id, title, titleKey, year, coverUrl, slug: null, status: 'approved', source: 'admin',
    submittedBy: oid(adminId), reviewedBy: oid(adminId), reviewedAt: new Date(),
  });
  await assignAlbumSlug(album._id, parent._id, title);
  await audit(adminId, 'catalog.create', String(album._id), title, { kind: 'album', title, artistId: String(parent._id) });
  return { album: (await CatalogAlbum.findById(album._id)) ?? album };
}

export async function adminUpdateCatalogEntry(adminId: string, kind: 'artist', id: string, patch: AdminArtistPatch): Promise<{ artist: ICatalogArtist } | CatalogError>;
export async function adminUpdateCatalogEntry(adminId: string, kind: 'album', id: string, patch: AdminAlbumPatch): Promise<{ album: ICatalogAlbum } | CatalogError>;
export async function adminUpdateCatalogEntry(
  adminId: string,
  kind: 'artist' | 'album',
  id: string,
  patch: AdminArtistPatch | AdminAlbumPatch,
): Promise<{ artist: ICatalogArtist } | { album: ICatalogAlbum } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  if (!validId(id)) return notFound();
  if (!patch || typeof patch !== 'object') return invalid('Patch is required');
  if (Object.values(patch).every((v) => v === undefined)) {
    // Nothing to write: no update, no timestamp bump, no audit entry.
    if (kind === 'artist') {
      const unchanged = await CatalogArtist.findById(oid(id));
      return unchanged ? { artist: unchanged } : notFound();
    }
    const unchanged = await CatalogAlbum.findById(oid(id));
    return unchanged ? { album: unchanged } : notFound();
  }
  // Only whitelisted fields are ever written: status, slug and source are never patchable.
  const set: Record<string, unknown> = {};

  if (kind === 'artist') {
    const p = patch as AdminArtistPatch;
    const current = await CatalogArtist.findById(oid(id)).lean();
    if (!current) return notFound();
    let disambiguation = current.disambiguation;
    if (p.disambiguation !== undefined) {
      const d = cleanDisambiguation(p.disambiguation);
      if (isError(d)) return d;
      disambiguation = d;
      set.disambiguation = d;
    }
    let nameKey = current.nameKey;
    if (p.name !== undefined) {
      const name = cleanName(p.name, CATALOG_LIMITS.maxArtistName, 'Name');
      if (isError(name)) return name;
      nameKey = artistKey(name);
      Object.assign(set, { name, nameKey });
    }
    // The homonym rule only matters when the entry becomes undisambiguated next to an approved
    // namesake: its key changed, or a disambiguation it had is being cleared. Re-sending
    // unchanged values must not trip it (a legacy entry may already sit beside a namesake).
    const keyChanged = nameKey !== current.nameKey;
    const clearing = !!current.disambiguation && !disambiguation;
    if ((keyChanged || clearing) && !disambiguation) {
      if (await CatalogArtist.exists({ nameKey, status: 'approved', _id: { $ne: current._id } })) return needsDisambiguation();
    }
    if (p.bio !== undefined) {
      const bio = cleanBio(p.bio);
      if (isError(bio)) return bio;
      set.bio = bio;
    }
    if (p.imageUrl !== undefined) {
      const imageUrl = cleanAdminImage(p.imageUrl);
      if (isError(imageUrl)) return imageUrl;
      const credit = resolveImageCredit(imageUrl, p.imageSource, p.imageSourceUrl);
      if (isError(credit)) return credit;
      Object.assign(set, { imageUrl, ...credit });
    } else if (p.imageSource !== undefined || p.imageSourceUrl !== undefined) {
      return invalid('An image source can only be set together with an image');
    }
    const artist = await CatalogArtist.findOneAndUpdate({ _id: current._id }, { $set: set }, { returnDocument: 'after' });
    if (!artist) return notFound();
    await audit(adminId, 'catalog.update', id, artist.name, { kind, name: artist.name, fields: Object.keys(set) });
    return { artist };
  }

  const p = patch as AdminAlbumPatch;
  const current = await CatalogAlbum.findById(oid(id)).lean();
  if (!current) return notFound();
  if (p.title !== undefined) {
    const title = cleanName(p.title, CATALOG_LIMITS.maxAlbumTitle, 'Title');
    if (isError(title)) return title;
    const titleKey = albumKey(title);
    if (titleKey !== current.titleKey) {
      const dup = await CatalogAlbum.exists({ artistId: current.artistId, titleKey, status: 'approved', _id: { $ne: current._id } });
      if (dup) return fail(409, 'CATALOG_DUPLICATE', 'This album already exists');
    }
    Object.assign(set, { title, titleKey });
  }
  if (p.year !== undefined) {
    const year = cleanYear(p.year);
    if (isError(year)) return year;
    set.year = year;
  }
  if (p.coverUrl !== undefined) {
    const coverUrl = cleanAdminImage(p.coverUrl);
    if (isError(coverUrl)) return coverUrl;
    set.coverUrl = coverUrl;
  }
  const album = await CatalogAlbum.findOneAndUpdate({ _id: current._id }, { $set: set }, { returnDocument: 'after' });
  if (!album) return notFound();
  await audit(adminId, 'catalog.update', id, album.title, { kind, title: album.title, fields: Object.keys(set) });
  return { album };
}

type Deletable = { _id: mongoose.Types.ObjectId; submittedBy: mongoose.Types.ObjectId };

/**
 * Revokes at most once per entry. The conditional true->false flip is evaluated at delete
 * time (never from a value read earlier) so a concurrent approval's fresh credit is still
 * revoked. A failing revoke is logged for manual repair and neither restores the flag nor
 * aborts the delete: revokeCatalogCredit is idempotent and re-runnable by contract.
 */
type RevokeFailure = { kind: 'artist' | 'album'; entryId: string; userId: string };

async function revokeOnce(kind: 'artist' | 'album', entry: Deletable): Promise<{ revokeFailed: boolean; failure?: RevokeFailure }> {
  const Model = (kind === 'artist' ? CatalogArtist : CatalogAlbum) as mongoose.Model<ICatalogArtist | ICatalogAlbum>;
  const flipped = await Model.updateOne({ _id: entry._id, creditAwarded: true }, { $set: { creditAwarded: false } });
  if (flipped.modifiedCount !== 1) return { revokeFailed: false };
  try {
    await revokeCatalogCredit(String(entry.submittedBy), kind);
    return { revokeFailed: false };
  } catch (err) {
    logFailure(`credit revoke (${kind} ${String(entry._id)}, user ${String(entry.submittedBy)})`, err);
    // Surfaced in the audit details so the failed revoke is actionable, not only a log line.
    return { revokeFailed: true, failure: { kind, entryId: String(entry._id), userId: String(entry.submittedBy) } };
  }
}

export async function adminDeleteCatalogEntry(
  adminId: string,
  kind: 'artist' | 'album',
  id: string,
  opts: { revokeCredit: boolean },
): Promise<{ ok: true } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  if (!validId(id)) return notFound();
  const revoke = opts?.revokeCredit === true;

  if (kind === 'album') {
    const album = await CatalogAlbum.findById(oid(id)).lean();
    if (!album) return notFound();
    const failedRevokes: RevokeFailure[] = [];
    if (revoke) {
      const r = await revokeOnce('album', album);
      if (r.failure) failedRevokes.push(r.failure);
    }
    const res = await CatalogAlbum.deleteOne({ _id: album._id });
    if (res.deletedCount !== 1) return notFound();
    if (album.status === 'approved') await onCatalogDeleted('album', id).catch((err) => logFailure('onCatalogDeleted', err));
    await audit(adminId, 'catalog.delete', id, album.title, {
      kind, title: album.title, revokeCredit: revoke, ...(failedRevokes.length ? { revokeFailed: true, failedRevokes } : {}),
    });
    return { ok: true };
  }

  const artist = await CatalogArtist.findById(oid(id)).lean();
  if (!artist) return notFound();
  const failedRevokes: RevokeFailure[] = [];
  if (revoke) {
    const r = await revokeOnce('artist', artist);
    if (r.failure) failedRevokes.push(r.failure);
  }
  // The artist goes first so an album approval starting after this point fails its parent
  // check. That narrows the race but does not close it: on a single instance, an approval that
  // already passed its parent check can still claim in the few milliseconds before the sweeps
  // below read the albums. The second sweep catches those; an approval landing after it is
  // not covered (it would leave an orphan approved album), which we accept at this scale.
  const res = await CatalogArtist.deleteOne({ _id: artist._id });
  if (res.deletedCount !== 1) return notFound();
  if (artist.status === 'approved') await onCatalogDeleted('artist', id).catch((err) => logFailure('onCatalogDeleted', err));

  // One failing album must not strand the rest: errors are collected and audited.
  let deleted = 0;
  const failedIds: string[] = [];
  const attempted = new Set<string>();
  const sweep = async (): Promise<void> => {
    const albums = (await CatalogAlbum.find({ artistId: artist._id }).lean()).filter((a) => !attempted.has(String(a._id)));
    for (const album of albums) {
      attempted.add(String(album._id));
      try {
        if (revoke) {
          const r = await revokeOnce('album', album);
          if (r.failure) failedRevokes.push(r.failure);
        }
        const del = await CatalogAlbum.deleteOne({ _id: album._id });
        if (del.deletedCount === 1) {
          deleted++;
          if (album.status === 'approved') await onCatalogDeleted('album', String(album._id));
        }
      } catch (err) {
        failedIds.push(String(album._id));
        logFailure(`album cascade (${String(album._id)})`, err);
      }
    }
  };
  await sweep();
  await sweep();
  await audit(adminId, 'catalog.delete', id, artist.name, {
    kind, name: artist.name, revokeCredit: revoke, albumsDeleted: deleted, albumsFailed: failedIds.length, failedAlbumIds: failedIds,
    ...(failedRevokes.length ? { revokeFailed: true, failedRevokes } : {}),
  });
  return { ok: true };
}

/** Creates approved albums for an approved artist from the album names on its public songs. */
export async function adminImportCatalogAlbums(adminId: string, artistId: string): Promise<{ created: number } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  if (!validId(artistId)) return notFound();
  const artist = await CatalogArtist.findOne({ _id: oid(artistId), status: 'approved' }).select('_id name nameKey').lean();
  if (!artist) return notFound();
  const created = await importAlbumsFromSongs(artist, adminId);
  await audit(adminId, 'catalog.import', artistId, artist.name, { kind: 'album', created });
  return { created };
}
