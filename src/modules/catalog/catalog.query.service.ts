import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import Project from '../projects/project.model.js';
import Artist from '../artists/artist.model.js';
import { artistKey } from '../artists/artist.service.js';
import { validId, oid, albumKey, cleanCatalogText } from './catalog.service.js';

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

const PUBLIC_FIELDS = '-reviewNote -submittedBy -reviewedBy -reviewedAt -creditAwarded';

type SongRow = {
  coverImage?: string | null;
  metadata?: { songAlbum?: string | null; artists?: Array<{ name?: string | null; role?: string | null }> | null } | null;
};

/**
 * The album key of a song, derived exactly like catalog album keys (see cleanCatalogText), so a song
 * and the catalog album it belongs to compare equal. Empty when the song names no album.
 */
export const songAlbumKey = (song: SongRow): string => albumKey(cleanCatalogText(String(song.metadata?.songAlbum ?? '')));

/** True when `nameKey` is credited as a primary artist: featured credits never decide an artist's albums. */
export const isPrimaryOf = (song: SongRow, nameKey: string): boolean =>
  (song.metadata?.artists ?? []).some((c) => c?.role === 'primary' && artistKey(String(c.name ?? '').trim()) === nameKey);

/**
 * Public page data: an approved artist, its approved albums and its public songs, by slug. Null for an
 * unknown, pending or rejected slug. Reviewer-only fields (note, submitter, reviewer) are dropped.
 *
 * `albumCards` is the album list the page shows. Only approved catalog albums appear, so a rejected
 * or dismissed album title on someone's song never becomes a card. Song counts and the fallback cover
 * come from primary credits only.
 */
export async function getPublicArtistBySlug(slug: string) {
  const key = typeof slug === 'string' ? slug.trim().toLowerCase().slice(0, 200) : '';
  if (!key) return null;
  const artist = await CatalogArtist.findOne({ slug: key, status: 'approved' }).select(PUBLIC_FIELDS).lean();
  if (!artist) return null;
  const [albums, songs] = await Promise.all([
    CatalogAlbum.find({ artistId: artist._id, status: 'approved' }).select(PUBLIC_FIELDS).sort({ year: 1, titleKey: 1, _id: 1 }).lean(),
    listPublicSongsByArtist(artist.name),
  ]);

  const stats = new Map<string, { songCount: number; cover: string | null }>();
  for (const song of songs as unknown as SongRow[]) {
    if (!isPrimaryOf(song, artist.nameKey)) continue;
    const k = songAlbumKey(song);
    if (!k) continue;
    const s = stats.get(k) ?? { songCount: 0, cover: null };
    s.songCount += 1;
    s.cover ??= song.coverImage || null;
    stats.set(k, s);
  }
  const albumCards = albums.map((album) => {
    const s = stats.get(album.titleKey);
    return { album, songCount: s?.songCount ?? 0, coverUrl: album.coverUrl ?? s?.cover ?? null };
  });
  return { artist, albums, albumCards, songs };
}

/**
 * Public album page: an approved album of an approved artist, addressed by both slugs, with the public
 * songs that credit the artist as primary and name this album. Null when either is unknown or unapproved.
 */
export async function getPublicAlbumBySlugs(artistSlug: string, albumSlug: string) {
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 200) : '');
  const [aKey, bKey] = [clean(artistSlug), clean(albumSlug)];
  if (!aKey || !bKey) return null;
  const artist = await CatalogArtist.findOne({ slug: aKey, status: 'approved' }).select(PUBLIC_FIELDS).lean();
  if (!artist) return null;
  const album = await CatalogAlbum.findOne({ artistId: artist._id, slug: bKey, status: 'approved' }).select(PUBLIC_FIELDS).lean();
  if (!album) return null;
  const songs = (await listPublicSongsByArtist(artist.name)).filter((song) => {
    const row = song as unknown as SongRow;
    return isPrimaryOf(row, artist.nameKey) && songAlbumKey(row) === album.titleKey;
  });
  songs.sort((a, b) => {
    const ta = (a as { metadata?: { trackNumber?: number | null } }).metadata?.trackNumber ?? Number.MAX_SAFE_INTEGER;
    const tb = (b as { metadata?: { trackNumber?: number | null } }).metadata?.trackNumber ?? Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
  const cover = album.coverUrl ?? (songs.find((s) => (s as unknown as SongRow).coverImage) as unknown as SongRow | undefined)?.coverImage ?? null;
  return { artist, album, songs, coverUrl: cover };
}

const SONGS_CAP = 500;

/**
 * Every publicly discoverable, non-subtitle project crediting `name` (primary or featured), from any user.
 * Matched by case-insensitive exact name; same discovery filter as explore, so hidden owners stay hidden.
 * Callers that decide albums must keep only primary credits (`isPrimaryOf`).
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

const SUGGEST_DEFAULT = 8;
const SUGGEST_MAX = 20;

export type CatalogSuggestion = { id: string; name: string; slug: string | null; disambiguation: string };

/**
 * Autocomplete over approved entries. Artists: names whose key starts with `prefix`, A to Z.
 * Albums: the approved albums of the one approved artist named `artist` (none for unknown names
 * or homonyms, so a namesake's albums are never offered), filtered by title prefix when given.
 */
export async function suggestCatalog(
  kind: 'artist' | 'album',
  opts: { prefix?: string | null; artist?: string | null; limit?: number | null },
): Promise<CatalogSuggestion[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SUGGEST_DEFAULT), 1), SUGGEST_MAX);
  const prefix = artistKey(String(opts.prefix ?? '').trim().slice(0, 100));
  // Anchored, so the { nameKey, status } index can serve it.
  const startsWith = prefix ? { $regex: `^${escapeRegex(prefix)}` } : undefined;

  if (kind === 'artist') {
    if (!startsWith) return [];
    const rows = await CatalogArtist.find({ status: 'approved', nameKey: startsWith })
      .select('name slug disambiguation').sort({ nameKey: 1, _id: 1 }).limit(limit).lean();
    return rows.map((r) => ({ id: String(r._id), name: r.name, slug: r.slug, disambiguation: r.disambiguation ?? '' }));
  }

  const artistName = artistKey(String(opts.artist ?? '').trim().slice(0, 300));
  if (!artistName) return [];
  const artists = await CatalogArtist.find({ status: 'approved', nameKey: artistName }).select('_id').limit(2).lean();
  if (artists.length !== 1) return [];
  const rows = await CatalogAlbum.find({ artistId: artists[0]._id, status: 'approved', ...(startsWith ? { titleKey: startsWith } : {}) })
    .select('title slug').sort({ year: -1, titleKey: 1, _id: 1 }).limit(limit).lean();
  return rows.map((r) => ({ id: String(r._id), name: r.title, slug: r.slug, disambiguation: '' }));
}

const BROWSE_DEFAULT = 24;
const BROWSE_MAX = 48;

/**
 * Public browse/search over approved artists: A to Z by name key, optionally filtered by a
 * case-insensitive substring of the name. Reviewer-only fields are never selected.
 */
export async function browseCatalogArtists(opts: { query?: string | null; offset?: number | null; limit?: number | null }) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? BROWSE_DEFAULT), 1), BROWSE_MAX);
  const offset = Math.min(Math.max(Math.trunc(opts.offset ?? 0), 0), 10_000);
  const q = typeof opts.query === 'string' ? opts.query.trim().normalize('NFC').slice(0, 100) : '';
  const filter = { status: 'approved' as const, slug: { $type: 'string' as const }, ...(q ? { nameKey: { $regex: escapeRegex(q.toLowerCase()) } } : {}) };
  const [items, total] = await Promise.all([
    CatalogArtist.find(filter).select(PUBLIC_FIELDS).sort({ nameKey: 1, _id: 1 }).skip(offset).limit(limit).lean(),
    CatalogArtist.countDocuments(filter),
  ]);
  return { items, total };
}

/**
 * The viewer's own artist record for a catalog artist (same name key) and how many of their songs
 * credit it as primary, private ones included: it points them at their personal artist page.
 * Null for anonymous viewers and for viewers with no such songs.
 */
export async function viewerShelfFor(viewerId: string | null | undefined, nameKey: string): Promise<{ artistId: string; songCount: number } | null> {
  if (!viewerId || !validId(viewerId) || !nameKey) return null;
  const own = await Artist.findOne({ userId: oid(viewerId), nameLower: nameKey }).select('_id').lean();
  if (!own) return null;
  const songCount = await Project.countDocuments({
    userId: oid(viewerId),
    kind: { $ne: 'subtitles' },
    'metadata.artists': { $elemMatch: { artistId: own._id, role: 'primary' } },
  });
  return songCount > 0 ? { artistId: String(own._id), songCount } : null;
}

/** Slugs of approved catalog artists matching the given names (case-insensitive); unknown names are omitted. */
export async function lookupCatalogSlugs(names: string[]) {
  const keys = [...new Set(names.slice(0, 50).map((n) => artistKey(String(n).trim())).filter(Boolean))];
  if (keys.length === 0) return [];
  const rows = await CatalogArtist.find({ status: 'approved', slug: { $type: 'string' }, nameKey: { $in: keys } })
    .select('name nameKey slug')
    .lean<{ name: string; nameKey: string; slug: string }[]>();
  return rows.map((r) => ({ name: r.name, key: r.nameKey, slug: r.slug }));
}
