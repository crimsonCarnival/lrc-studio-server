import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import Project from '../projects/project.model.js';
import { validId, oid } from './catalog.service.js';

const QUEUE_CAP = 100;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pending entries, oldest first. Capped so a flood of submissions cannot make the queue unbounded. */
export async function listReviewQueue() {
  const [artists, albums] = await Promise.all([
    CatalogArtist.find({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).limit(QUEUE_CAP).lean(),
    CatalogAlbum.find({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).limit(QUEUE_CAP).lean(),
  ]);
  return { artists, albums };
}

export async function listApprovedArtists(opts: { query?: string | null; offset?: number | null; limit?: number | null }) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 50);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const q = typeof opts.query === 'string' ? opts.query.trim().slice(0, 100) : '';
  const filter = { status: 'approved' as const, ...(q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {}) };
  return CatalogArtist.find(filter).sort({ nameKey: 1, _id: 1 }).skip(offset).limit(limit).lean();
}

export async function listApprovedAlbums(artistId: string) {
  if (!validId(artistId)) return [];
  return CatalogAlbum.find({ artistId: oid(artistId), status: 'approved' }).sort({ year: 1, titleKey: 1, _id: 1 }).lean();
}

/**
 * Public page data: an approved artist and its approved albums, by slug. Null for an unknown, pending or
 * rejected slug. Reviewer-only fields (note, submitter, reviewer) are dropped so nothing internal leaks.
 */
export async function getPublicArtistBySlug(slug: string) {
  const key = typeof slug === 'string' ? slug.trim().toLowerCase().slice(0, 200) : '';
  if (!key) return null;
  const artist = await CatalogArtist.findOne({ slug: key, status: 'approved' })
    .select('-reviewNote -submittedBy -reviewedBy -reviewedAt -creditAwarded')
    .lean();
  if (!artist) return null;
  const albums = await CatalogAlbum.find({ artistId: artist._id, status: 'approved' })
    .select('-reviewNote -submittedBy -reviewedBy -reviewedAt -creditAwarded')
    .sort({ year: 1, titleKey: 1, _id: 1 })
    .lean();
  const songs = await listPublicSongsByArtist(artist.name);
  return { artist, albums, songs };
}

const SONGS_CAP = 500;

/**
 * Every publicly discoverable, non-subtitle project crediting `name` (primary or featured), from any user.
 * Matched by case-insensitive exact name; same discovery filter as explore, so hidden owners stay hidden.
 */
export async function listPublicSongsByArtist(name: string) {
  const exact = new RegExp(`^${escapeRegex(name.normalize('NFC'))}$`, 'i');
  return Project.find({
    public: true,
    ownerListed: true,
    ownerActive: { $ne: false },
    listed: { $ne: false },
    kind: { $ne: 'subtitles' },
    'metadata.artists': { $elemMatch: { name: exact } },
  })
    .sort({ 'metadata.songAlbum': 1, 'metadata.trackNumber': 1, title: 1, _id: 1 })
    .limit(SONGS_CAP);
}
