import { getEnv } from '../../config/env.js';
import { stripHtml } from '../../utils/sanitize.js';
import { LRUCache } from '@crimson-carnival/ds-js';
import { bestMatch, rankCandidates, type RankedCandidate, type TrackCandidate, type TrackQuery } from './song-metadata.match.js';

const PROVIDER_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PROVIDER_API_BASE = 'https://api.spotify.com/v1';
// Every upstream call has a timeout; an abort is caught by its provider and that
// provider simply contributes no candidates.
const FETCH_TIMEOUT_MS = 8000;
// How many hits each provider is asked for. Their own ranking is by popularity, so the
// song the user means is often not the first hit; rankCandidates() picks it out.
const PROVIDER_LIMIT = 15;
// What /search returns at most.
const RESULT_LIMIT = 8;
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;

const searchCache = new LRUCache<string, { at: number; results: RankedCandidate[] }>(200);

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function isProviderConfigured(): boolean {
  const env = getEnv();
  return !!(env.TRACK_METADATA_CLIENT_ID && env.TRACK_METADATA_CLIENT_SECRET);
}

async function getProviderToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const env = getEnv();
  const basicAuth = `Basic ${Buffer.from(`${env.TRACK_METADATA_CLIENT_ID}:${env.TRACK_METADATA_CLIENT_SECRET}`).toString('base64')}`;

  const response = await fetch(PROVIDER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Track metadata provider token request failed: ${response.status}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * The free-text query every provider gets: title and primary artists. Featured artists are left
 * out: keyword search ANDs its terms, and a guest the provider credits differently (or only in
 * the title) would empty the results. They count in the ranking instead.
 */
function queryText(q: TrackQuery): string {
  return [q.songName, q.artistName].map((s) => s?.trim()).filter(Boolean).join(' ');
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { name: string; images?: { url: string }[]; release_date?: string; total_tracks?: number };
  duration_ms: number;
  track_number?: number;
  preview_url?: string | null;
  explicit?: boolean;
}

async function searchSpotify(q: TrackQuery): Promise<TrackCandidate[]> {
  const token = await getProviderToken();
  // Plain text, not `track:… artist:…`: a field filter only covers the next word, so
  // `artist:Lil Peep` filtered on "Lil" and left "Peep" loose.
  const params = new URLSearchParams({ q: queryText(q), type: 'track', limit: String(PROVIDER_LIMIT), market: 'US' });
  const res = await fetch(`${PROVIDER_API_BASE}/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Spotify search failed: ${res.status}`);
  const data = await res.json() as { tracks?: { items?: SpotifyTrack[] } };
  const tracks = (data.tracks?.items ?? []).filter((t) => t?.id);

  // Genres live on artists: one batched call covers every candidate.
  const genresByArtist = new Map<string, string[]>();
  const artistIds = [...new Set(tracks.flatMap((t) => (t.artists ?? []).map((a) => a.id)).filter(Boolean))].slice(0, 50);
  if (artistIds.length > 0) {
    try {
      const artistRes = await fetch(`${PROVIDER_API_BASE}/artists?ids=${artistIds.join(',')}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (artistRes.ok) {
        const artistData = await artistRes.json() as { artists: ({ id: string; genres?: string[] } | null)[] };
        for (const a of artistData.artists ?? []) if (a?.id) genresByArtist.set(a.id, a.genres ?? []);
      }
    } catch { /* genres stay empty */ }
  }

  return tracks.map((track) => ({
    provider: 'spotify' as const,
    trackId: track.id,
    name: stripHtml(track.name || ''),
    artist: stripHtml((track.artists ?? []).map((a) => a.name).join(', ')),
    album: stripHtml(track.album?.name || ''),
    duration: track.duration_ms ?? 0,
    albumArt: track.album?.images?.[0]?.url || null,
    releaseYear: track.album?.release_date ? track.album.release_date.slice(0, 4) : null,
    totalTracks: track.album?.total_tracks ?? null,
    trackNumber: track.track_number ?? null,
    previewUrl: track.preview_url || null,
    explicit: !!track.explicit,
    genres: [...new Set((track.artists ?? []).flatMap((a) => genresByArtist.get(a.id) ?? []))],
  }));
}

interface ITunesSearchResponse {
  results?: {
    trackId?: number;
    trackName?: string;
    artistName?: string;
    collectionName?: string;
    artworkUrl100?: string;
    releaseDate?: string;
    primaryGenreName?: string;
    trackTimeMillis?: number;
    trackNumber?: number;
    trackCount?: number;
    previewUrl?: string;
    trackExplicitness?: string;
  }[];
}

async function searchItunes(q: TrackQuery): Promise<TrackCandidate[]> {
  const params = new URLSearchParams({ term: queryText(q), entity: 'song', limit: String(PROVIDER_LIMIT), country: 'US' });
  const res = await fetch(`https://itunes.apple.com/search?${params}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`iTunes search failed: ${res.status}`);
  const data = await res.json() as ITunesSearchResponse;

  return (data.results ?? []).filter((t) => t.trackName).map((track) => ({
    provider: 'itunes' as const,
    trackId: track.trackId != null ? String(track.trackId) : '',
    name: stripHtml(track.trackName || ''),
    artist: stripHtml(track.artistName || ''),
    album: stripHtml(track.collectionName || ''),
    duration: track.trackTimeMillis ?? 0,
    albumArt: track.artworkUrl100 ? track.artworkUrl100.replace('100x100', '600x600') : null,
    releaseYear: track.releaseDate ? track.releaseDate.slice(0, 4) : null,
    totalTracks: track.trackCount ?? null,
    trackNumber: track.trackNumber ?? null,
    previewUrl: track.previewUrl || null,
    explicit: track.trackExplicitness === 'explicit',
    genres: track.primaryGenreName ? [track.primaryGenreName] : [],
  }));
}

interface DeezerSearchResponse {
  data?: {
    id?: number;
    title?: string;
    artist?: { name?: string };
    contributors?: { name?: string }[];
    album?: { id?: number; title?: string; cover_big?: string };
    duration?: number;
    preview?: string;
    explicit_lyrics?: boolean;
  }[];
}

interface DeezerAlbumResponse {
  release_date?: string;
  nb_tracks?: number;
  genres?: { data?: { name?: string }[] };
}

// Deezer's search hits carry no year, track count or genres; those come from the album,
// fetched only for the Deezer results that make the final list. Track id → album id.
const deezerAlbumIds = new LRUCache<string, number>(1000);

async function searchDeezer(q: TrackQuery): Promise<TrackCandidate[]> {
  const res = await fetch(`https://api.deezer.com/search?${new URLSearchParams({ q: queryText(q), limit: String(PROVIDER_LIMIT) })}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Deezer search failed: ${res.status}`);
  const data = await res.json() as DeezerSearchResponse;

  return (data.data ?? []).filter((t) => t.title).map((track) => {
    const names = (track.contributors ?? []).map((c) => c.name).filter((n): n is string => !!n);
    const candidate: TrackCandidate = {
      provider: 'deezer',
      trackId: track.id != null ? String(track.id) : '',
      name: stripHtml(track.title || ''),
      artist: stripHtml(names.length > 0 ? names.join(', ') : track.artist?.name || ''),
      album: stripHtml(track.album?.title || ''),
      duration: track.duration ? track.duration * 1000 : 0,
      albumArt: track.album?.cover_big || null,
      releaseYear: null,
      totalTracks: null,
      trackNumber: null,
      previewUrl: track.preview || null,
      explicit: !!track.explicit_lyrics,
      genres: [],
    };
    if (candidate.trackId && track.album?.id) deezerAlbumIds.put(candidate.trackId, track.album.id);
    return candidate;
  });
}

async function fillDeezerAlbum(c: RankedCandidate, albumId: number): Promise<void> {
  try {
    const res = await fetch(`https://api.deezer.com/album/${albumId}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return;
    const album = await res.json() as DeezerAlbumResponse;
    c.releaseYear ??= album.release_date ? album.release_date.slice(0, 4) : null;
    c.totalTracks ??= album.nb_tracks ?? null;
    if (c.genres.length === 0) c.genres = (album.genres?.data ?? []).map((g) => g.name).filter((n): n is string => !!n);
  } catch { /* album extras stay empty */ }
}

function cacheKey(q: TrackQuery): string {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  return [norm(q.songName), norm(q.artistName), ...(q.featuredArtists ?? []).map(norm).sort()].join('\u0000');
}

export type SearchOutcome = { results: RankedCandidate[] } | { error: string; status: number };

/**
 * Asks every provider at once, then ranks: tracks by the requested artist first, the exact
 * title and the requested featured artists next. A 502 only when every provider failed;
 * an empty list means they answered and nothing fit.
 */
export async function searchTracks(q: TrackQuery): Promise<SearchOutcome> {
  const key = cacheKey(q);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return { results: hit.results.map((r) => ({ ...r, genres: [...r.genres] })) };

  const searches: Promise<TrackCandidate[]>[] = [searchItunes(q), searchDeezer(q)];
  if (isProviderConfigured()) searches.unshift(searchSpotify(q));
  const settled = await Promise.allSettled(searches);

  const candidates: TrackCandidate[] = [];
  let failures = 0;
  for (const s of settled) {
    if (s.status === 'fulfilled') candidates.push(...s.value);
    else { failures++; console.error('[song-metadata] provider search failed:', s.reason); }
  }
  if (failures === settled.length) return { error: 'Track metadata search failed', status: 502 };

  const ranked = rankCandidates(candidates, q, RESULT_LIMIT);
  await Promise.all(ranked.map((r) => {
    if (r.provider !== 'deezer' || r.releaseYear) return null;
    const albumId = deezerAlbumIds.get(r.trackId);
    return albumId ? fillDeezerAlbum(r, albumId) : null;
  }));

  searchCache.put(key, { at: Date.now(), results: ranked });
  return { results: ranked.map((r) => ({ ...r, genres: [...r.genres] })) };
}

/** The single best track, only when it is by the requested artist. Kept for clients that predate /search. */
export async function lookupTrack(songName: string, artistName?: string, featuredArtists: string[] = []): Promise<Record<string, unknown>> {
  const outcome = await searchTracks({ songName, artistName, featuredArtists });
  if ('error' in outcome) return outcome;
  const best = bestMatch(outcome.results);
  if (!best) return { error: 'No matching track found', status: 404 };
  return { ...best };
}
