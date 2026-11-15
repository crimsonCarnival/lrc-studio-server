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
import { CATALOG_LIMITS } from './catalog.limits.js';
import { artistKey } from '../artists/artist.service.js';
import { isCatalogImageUrl } from '../uploads/uploads.service.js';
import { hasPermission } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import { logAdminAction } from '../admin/admin.service.js';

const MAX_DISAMBIGUATION = 80;

export type AdminArtistInput = ArtistInput & { disambiguation?: string };
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
async function assertManager(adminId: string): Promise<CatalogError | null> {
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

function cleanDisambiguation(raw: unknown): string | CatalogError {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return invalid('Disambiguation must be text');
  const v = squash(stripHtml(raw)).normalize('NFC');
  if (v.length > MAX_DISAMBIGUATION) return invalid(`Disambiguation must be at most ${MAX_DISAMBIGUATION} characters`);
  return v;
}

const needsDisambiguation = (): CatalogError =>
  fail(422, 'CATALOG_DISAMBIGUATION_REQUIRED', 'An approved artist with this name exists; add a disambiguation');

async function audit(adminId: string, action: 'catalog.create' | 'catalog.update' | 'catalog.delete', id: string, name: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await logAdminAction({ adminId, action, targetId: id, targetName: name, details: JSON.stringify(meta) });
  } catch (err) {
    logFailure('admin log', err);
  }
}

export async function adminCreateCatalogArtist(adminId: string, input: AdminArtistInput): Promise<{ artist: ICatalogArtist } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  const name = cleanName(input?.name, CATALOG_LIMITS.maxArtistName, 'Name');
  if (isError(name)) return name;
  const bio = cleanBio(input.bio);
  if (isError(bio)) return bio;
  const imageUrl = cleanAdminImage(input.imageUrl);
  if (isError(imageUrl)) return imageUrl;
  const disambiguation = cleanDisambiguation(input.disambiguation);
  if (isError(disambiguation)) return disambiguation;

  const nameKey = artistKey(name);
  if (!disambiguation && (await CatalogArtist.exists({ nameKey, status: 'approved' }))) return needsDisambiguation();

  const artist = await CatalogArtist.create({
    name, nameKey, bio, imageUrl, disambiguation, slug: null, status: 'approved', source: 'admin',
    submittedBy: oid(adminId), reviewedBy: oid(adminId), reviewedAt: new Date(),
  });
  await assignArtistSlug(artist._id, name);
  await audit(adminId, 'catalog.create', String(artist._id), name, { kind: 'artist', name });
  return { artist: (await CatalogArtist.findById(artist._id)) ?? artist };
}

export async function adminCreateCatalogAlbum(adminId: string, input: AlbumInput): Promise<{ album: ICatalogAlbum } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  const title = cleanName(input?.title, CATALOG_LIMITS.maxAlbumTitle, 'Title');
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
    if (p.name !== undefined) {
      const name = cleanName(p.name, CATALOG_LIMITS.maxArtistName, 'Name');
      if (isError(name)) return name;
      const nameKey = artistKey(name);
      Object.assign(set, { name, nameKey });
      if (nameKey !== current.nameKey || p.disambiguation !== undefined) {
        const clash = await CatalogArtist.exists({ nameKey, status: 'approved', _id: { $ne: current._id } });
        if (clash && !disambiguation) return needsDisambiguation();
      }
    } else if (p.disambiguation !== undefined && !disambiguation) {
      // Clearing disambiguation must not recreate an undisambiguated homonym.
      if (await CatalogArtist.exists({ nameKey: current.nameKey, status: 'approved', _id: { $ne: current._id } })) return needsDisambiguation();
    }
    if (p.bio !== undefined) {
      const bio = cleanBio(p.bio);
      if (isError(bio)) return bio;
      set.bio = bio;
    }
    if (p.imageUrl !== undefined) {
      const imageUrl = cleanAdminImage(p.imageUrl);
      if (isError(imageUrl)) return imageUrl;
      set.imageUrl = imageUrl;
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

type Deletable = { _id: mongoose.Types.ObjectId; status: string; submittedBy: mongoose.Types.ObjectId; creditAwarded: boolean };

/** Revokes at most once per entry: the true->false flip is the guard, restored if the revoke throws. */
async function revokeOnce(kind: 'artist' | 'album', entry: Deletable): Promise<void> {
  if (!entry.creditAwarded) return;
  const Model = (kind === 'artist' ? CatalogArtist : CatalogAlbum) as mongoose.Model<ICatalogArtist | ICatalogAlbum>;
  const flipped = await Model.updateOne({ _id: entry._id, creditAwarded: true }, { $set: { creditAwarded: false } });
  if (flipped.modifiedCount !== 1) return;
  try {
    await revokeCatalogCredit(String(entry.submittedBy), kind);
  } catch (err) {
    await Model.updateOne({ _id: entry._id }, { $set: { creditAwarded: true } }).catch((e) => logFailure('credit flag restore', e));
    throw err;
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
    if (revoke) await revokeOnce('album', album);
    const res = await CatalogAlbum.deleteOne({ _id: album._id });
    if (res.deletedCount !== 1) return notFound();
    if (album.status === 'approved') await onCatalogDeleted('album', id).catch((err) => logFailure('onCatalogDeleted', err));
    await audit(adminId, 'catalog.delete', id, album.title, { kind, title: album.title, revokeCredit: revoke });
    return { ok: true };
  }

  const artist = await CatalogArtist.findById(oid(id)).lean();
  if (!artist) return notFound();
  if (revoke) await revokeOnce('artist', artist);
  // The artist goes first so a concurrent album approval fails its parent check;
  // the cascade below then sweeps any album that slipped through the window.
  const res = await CatalogArtist.deleteOne({ _id: artist._id });
  if (res.deletedCount !== 1) return notFound();
  if (artist.status === 'approved') await onCatalogDeleted('artist', id).catch((err) => logFailure('onCatalogDeleted', err));

  const albums = await CatalogAlbum.find({ artistId: artist._id }).lean();
  for (const album of albums) {
    if (revoke) await revokeOnce('album', album);
    const del = await CatalogAlbum.deleteOne({ _id: album._id });
    if (del.deletedCount === 1 && album.status === 'approved') {
      await onCatalogDeleted('album', String(album._id)).catch((err) => logFailure('onCatalogDeleted', err));
    }
  }
  await audit(adminId, 'catalog.delete', id, artist.name, { kind, name: artist.name, revokeCredit: revoke, albumsDeleted: albums.length });
  return { ok: true };
}
