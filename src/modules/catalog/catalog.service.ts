import mongoose from 'mongoose';
import User from '../users/user.model.js';
import CatalogArtist, { type ICatalogArtist } from './catalog-artist.model.js';
import CatalogAlbum, { type ICatalogAlbum } from './catalog-album.model.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { artistKey } from '../artists/artist.service.js';
import { isCatalogImageUrl } from '../uploads/uploads.service.js';
import { stripHtml } from '../../utils/sanitize.js';

export type CatalogErrorCode =
  | 'CATALOG_UNVERIFIED'
  | 'CATALOG_RATE_LIMITED'
  | 'CATALOG_PENDING_CAP'
  | 'CATALOG_DUPLICATE'
  | 'CATALOG_PARENT_NOT_APPROVED'
  | 'CATALOG_INVALID_IMAGE'
  | 'CATALOG_INVALID_INPUT'
  | 'CATALOG_NOT_FOUND';

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

const fail = (status: number, code: CatalogErrorCode, error: string, existing?: CatalogError['existing']): CatalogError => ({
  error,
  status,
  code,
  ...(existing ? { existing } : {}),
});
const invalid = (error: string): CatalogError => fail(400, 'CATALOG_INVALID_INPUT', error);
const notFound = (): CatalogError => fail(404, 'CATALOG_NOT_FOUND', 'Entry not found');

const isError = (v: unknown): v is CatalogError => typeof v === 'object' && v !== null && 'code' in v && 'error' in v;
const validId = (id: unknown): id is string => typeof id === 'string' && mongoose.isValidObjectId(id);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function cleanName(raw: unknown, max: number, label: string): string | CatalogError {
  if (typeof raw !== 'string') return invalid(`${label} is required`);
  const v = squash(raw).normalize('NFC');
  if (!v) return invalid(`${label} is required`);
  if (v.length > max) return invalid(`${label} must be at most ${max} characters`);
  return v;
}

function cleanBio(raw: unknown): string | CatalogError {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return invalid('Bio must be text');
  // Sanitize first, then measure: markup must not count against the cap.
  const v = stripHtml(raw);
  if (v.length > CATALOG_LIMITS.maxBio) return invalid(`Bio must be at most ${CATALOG_LIMITS.maxBio} characters`);
  return v;
}

function cleanYear(raw: unknown): string | null | CatalogError {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return invalid('Year must be text');
  const v = raw.trim();
  if (v.length > CATALOG_LIMITS.maxYear) return invalid(`Year must be at most ${CATALOG_LIMITS.maxYear} characters`);
  return v || null;
}

/** Community users may only reference images they uploaded themselves. */
function cleanImage(raw: unknown, userId: string): string | null | CatalogError {
  if (raw === undefined || raw === null) return null;
  if (!isCatalogImageUrl(raw, userId)) return fail(422, 'CATALOG_INVALID_IMAGE', 'Image must be uploaded through the catalog uploader');
  return raw;
}

async function assertCanSubmit(userId: string): Promise<CatalogError | null> {
  const user = await User.findById(userId).select('isVerified').lean();
  if (!user?.isVerified) return fail(403, 'CATALOG_UNVERIFIED', 'Verify your email to submit to the catalog');
  const submittedBy = oid(userId);
  const since = new Date(Date.now() - CATALOG_LIMITS.windowMs);
  const [dayA, dayB, pendA, pendB] = await Promise.all([
    CatalogArtist.countDocuments({ submittedBy, createdAt: { $gte: since } }),
    CatalogAlbum.countDocuments({ submittedBy, createdAt: { $gte: since } }),
    CatalogArtist.countDocuments({ submittedBy, status: 'pending' }),
    CatalogAlbum.countDocuments({ submittedBy, status: 'pending' }),
  ]);
  if (dayA + dayB >= CATALOG_LIMITS.maxPerDay) return fail(429, 'CATALOG_RATE_LIMITED', 'Too many submissions in the last 24 hours');
  if (pendA + pendB >= CATALOG_LIMITS.maxPending) return fail(429, 'CATALOG_PENDING_CAP', 'Too many pending submissions');
  return null;
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
    (await CatalogArtist.findOne({ ...base, status: 'pending' }).sort({ createdAt: 1 }).lean());
  return duplicateOf(userId, hit, hit?.name ?? '');
}

async function findAlbumDuplicate(userId: string, artistId: mongoose.Types.ObjectId, titleKey: string, excludeId?: string): Promise<CatalogError | null> {
  const base = { artistId, titleKey, ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}) };
  const hit =
    (await CatalogAlbum.findOne({ ...base, status: 'approved' }).lean()) ??
    (await CatalogAlbum.findOne({ ...base, status: 'pending' }).sort({ createdAt: 1 }).lean());
  return duplicateOf(userId, hit, hit?.title ?? '');
}

const albumKey = (title: string): string => artistKey(title.trim());

export async function submitCatalogArtist(userId: string, input: ArtistInput): Promise<{ artist: ICatalogArtist } | CatalogError> {
  const name = cleanName(input?.name, CATALOG_LIMITS.maxArtistName, 'Name');
  if (isError(name)) return name;
  const bio = cleanBio(input.bio);
  if (isError(bio)) return bio;
  const imageUrl = cleanImage(input.imageUrl, userId);
  if (isError(imageUrl)) return imageUrl;

  const blocked = await assertCanSubmit(userId);
  if (blocked) return blocked;
  const nameKey = artistKey(name);
  const dup = await findArtistDuplicate(userId, nameKey);
  if (dup) return dup;

  const artist = await CatalogArtist.create({
    name, nameKey, bio, imageUrl, slug: null, status: 'pending', source: 'community', submittedBy: oid(userId),
  });
  return { artist };
}

export async function submitCatalogAlbum(userId: string, input: AlbumInput): Promise<{ album: ICatalogAlbum } | CatalogError> {
  const title = cleanName(input?.title, CATALOG_LIMITS.maxAlbumTitle, 'Title');
  if (isError(title)) return title;
  const year = cleanYear(input.year);
  if (isError(year)) return year;
  const coverUrl = cleanImage(input.coverUrl, userId);
  if (isError(coverUrl)) return coverUrl;

  const blocked = await assertCanSubmit(userId);
  if (blocked) return blocked;
  const parentError = fail(422, 'CATALOG_PARENT_NOT_APPROVED', 'The artist must be approved first');
  if (!validId(input.artistId)) return parentError;
  const parent = await CatalogArtist.findOne({ _id: oid(input.artistId), status: 'approved' }).select('_id').lean();
  if (!parent) return parentError;

  const titleKey = albumKey(title);
  const dup = await findAlbumDuplicate(userId, parent._id, titleKey);
  if (dup) return dup;

  const album = await CatalogAlbum.create({
    artistId: parent._id, title, titleKey, year, coverUrl, slug: null, status: 'pending', source: 'community', submittedBy: oid(userId),
  });
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
