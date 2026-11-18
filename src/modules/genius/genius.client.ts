import { getEnv } from '../../config/env.js';

const BASE_URL = 'https://api.genius.com';
const FETCH_TIMEOUT_MS = 8000;

export type GeniusArtist = { id?: number; name: string; url?: string; image_url?: string };
export type GeniusArtistDetail = { id: number; name: string; url: string; image_url: string | null };
export type GeniusHit = { id: number; title: string; url: string; primary_artist: GeniusArtist };
export type GeniusRelatedSong = GeniusHit & { song_art_image_thumbnail_url?: string };
export type GeniusSong = GeniusHit & {
  album?: { name: string } | null;
  release_date?: string | null;
  song_relationships: { relationship_type: string; songs: GeniusRelatedSong[] }[];
};

/**
 * GET against api.genius.com. Returns null when the token is unset (feature off).
 * Errors are opaque codes: neither the token nor upstream text ever reaches a message.
 */
async function geniusGet(path: string): Promise<unknown | null> {
  const token = getEnv().GENIUS_CLIENT_ACCESS_TOKEN;
  if (!token) return null;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('genius_upstream');
  }
  if (res.status === 401 || res.status === 403) throw new Error('genius_unauthorized');
  if (!res.ok) throw new Error('genius_upstream');
  try {
    return await res.json();
  } catch {
    throw new Error('genius_upstream');
  }
}

function assertValidId(id: unknown): void {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('genius_invalid_id');
}

export async function searchSong(q: string): Promise<GeniusHit[] | null> {
  const body = await geniusGet(`/search?q=${encodeURIComponent(q)}`) as
    { response?: { hits?: { result?: GeniusHit }[] } } | null;
  if (!body) return null;
  const hits = body.response?.hits;
  return (Array.isArray(hits) ? hits : []).flatMap((h) => (h?.result ? [h.result] : []));
}

export async function getSong(id: number): Promise<GeniusSong | null> {
  assertValidId(id);
  const body = await geniusGet(`/songs/${id}?text_format=plain`) as
    { response?: { song?: GeniusSong } } | null;
  if (!body) return null;
  if (!body.response?.song) throw new Error('genius_upstream');
  return body.response.song;
}

export async function getArtist(id: number): Promise<GeniusArtistDetail | null> {
  assertValidId(id);
  const body = await geniusGet(`/artists/${id}?text_format=plain`) as
    { response?: { artist?: { id: number; name: string; url: string; image_url?: string } } } | null;
  if (!body) return null;
  const a = body.response?.artist;
  if (!a) throw new Error('genius_upstream');
  return { id: a.id, name: a.name, url: a.url, image_url: a.image_url ?? null };
}
