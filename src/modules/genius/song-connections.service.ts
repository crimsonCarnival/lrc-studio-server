import { artistKey } from '../artists/artist.service.js';
import { getEnv } from '../../config/env.js';
import { getSong, searchSong, type GeniusRelatedSong } from './genius.client.js';

export type ConnectionType =
  | 'samples' | 'sampled_in' | 'interpolates' | 'interpolated_by'
  | 'cover_of' | 'covered_by' | 'remix_of' | 'remixed_by';

export type SongConnections = {
  geniusId: number;
  url: string;
  title: string;
  artist: string;
  album: string | null;
  releaseDate: string | null;
  groups: {
    type: ConnectionType;
    total: number;
    songs: { geniusId: number; title: string; artist: string; url: string; thumbnail: string | null }[];
  }[];
};

const TYPES: ConnectionType[] = [
  'samples', 'sampled_in', 'interpolates', 'interpolated_by',
  'cover_of', 'covered_by', 'remix_of', 'remixed_by',
];
const MAX_SONGS = 8;
const CACHE_MAX = 500;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const GENIUS_URL_PREFIX = 'https://genius.com/';

type CacheEntry = { value: SongConnections | null; expires: number };
const cache = new Map<string, CacheEntry>();

export function clearConnectionsCache(): void {
  cache.clear();
}

export function isGeniusConfigured(): boolean {
  return !!getEnv().GENIUS_CLIENT_ACCESS_TOKEN;
}

const matchKey = (s: string): string => artistKey(s).replace(/\s+/g, ' ').trim();

function cacheGet(key: string): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) { cache.delete(key); return undefined; }
  cache.delete(key); // re-insert: Map order doubles as LRU order
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: SongConnections | null): void {
  cache.delete(key);
  cache.set(key, { value, expires: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

const IMAGE_HOST = /^https:\/\/([a-z0-9-]+\.)*genius\.com\//i;
const safeThumb = (u: unknown): string | null =>
  typeof u === 'string' && IMAGE_HOST.test(u) ? u : null;

const toSong = (s: GeniusRelatedSong): SongConnections['groups'][number]['songs'][number] => ({
  geniusId: s.id,
  title: s.title,
  artist: s.primary_artist.name,
  url: s.url,
  thumbnail: safeThumb(s.song_art_image_thumbnail_url),
});

async function findGeniusId(track: string, artist: string): Promise<number | null> {
  const trackKey = matchKey(track);
  const wantArtist = matchKey(artist);
  if (!trackKey || !wantArtist) return null;
  const hits = await searchSong(`${track} ${artist}`);
  if (!hits) return null;
  const sameArtist = hits.filter((h) => typeof h?.primary_artist?.name === 'string'
    && typeof h.title === 'string' && matchKey(h.primary_artist.name) === wantArtist);
  // Exact title anywhere in the hits wins; Genius ranks by popularity, so a first-match
  // prefix rule would let "Love" resolve to a more popular "Love Story".
  const exact = sameArtist.find((h) => matchKey(h.title) === trackKey);
  if (exact) return exact.id;
  const suffixes = [`${trackKey} (`, `${trackKey} [`, `${trackKey} -`];
  const suffixed = sameArtist.find((h) => suffixes.some((p) => matchKey(h.title).startsWith(p)));
  return suffixed ? suffixed.id : null;
}

async function load(geniusId: number): Promise<SongConnections | null> {
  return guarded(() => loadUnsafe(geniusId));
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Opaque genius_* codes pass through; any unexpected shape becomes genius_upstream.
    if (e instanceof Error && e.message.startsWith('genius_')) throw e;
    throw new Error('genius_upstream', { cause: e });
  }
}

async function loadUnsafe(geniusId: number): Promise<SongConnections | null> {
  const song = await getSong(geniusId);
  if (!song) return null;
  if (typeof song.url !== 'string' || !song.url.startsWith(GENIUS_URL_PREFIX)) return null;
  const groups: SongConnections['groups'] = [];
  for (const type of TYPES) {
    const songs = (song.song_relationships ?? [])
      .filter((r) => r.relationship_type === type)
      .flatMap((r) => r.songs ?? [])
      .filter((s) => typeof s?.primary_artist?.name === 'string'
        && typeof s.url === 'string' && s.url.startsWith(GENIUS_URL_PREFIX));
    if (songs.length === 0) continue;
    groups.push({ type, total: songs.length, songs: songs.slice(0, MAX_SONGS).map(toSong) });
  }
  return {
    geniusId: song.id,
    url: song.url,
    title: song.title,
    artist: song.primary_artist.name,
    album: song.album?.name ?? null,
    releaseDate: song.release_date ?? null,
    groups,
  };
}

/** null = no confident match (or Genius unconfigured). Throws genius_* opaque errors. */
export async function getSongConnections(
  q: { track: string; artist: string } | { geniusId: number },
): Promise<SongConnections | null> {
  if (!isGeniusConfigured()) return null;
  if ('geniusId' in q && (!Number.isInteger(q.geniusId) || q.geniusId <= 0)) return null;
  const key = 'geniusId' in q
    ? `g:${q.geniusId}`
    : `t:${matchKey(q.track)}|${matchKey(q.artist)}`;
  const cached = cacheGet(key);
  if (cached) return cached.value;

  const id = 'geniusId' in q ? q.geniusId : await guarded(() => findGeniusId(q.track, q.artist));
  const value = id === null ? null : await load(id);
  cacheSet(key, value);
  return value;
}
