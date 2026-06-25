import { getEnv } from '../../config/env.js';
import { stripHtml } from '../../utils/sanitize.js';
import { LRUCache } from '@crimson-carnival/ds-js';
import { insertAutocompleteTerms } from './autocomplete.trie.js';

const PROVIDER_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PROVIDER_API_BASE = 'https://api.spotify.com/v1';

const trackCache = new LRUCache(100);

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
  });

  if (!response.ok) {
    throw new Error(`Track metadata provider token request failed: ${response.status}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function fetchTrackDetails(trackId: string): Promise<Record<string, unknown>> {
  const cached = trackCache.get(trackId) as Record<string, unknown> | undefined;
  if (cached) return cached;

  const token = await getProviderToken();
  const response = await fetch(`${PROVIDER_API_BASE}/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 404) return { error: 'Track not found', status: 404 };
    return { error: 'Track metadata request failed', status: 502 };
  }

  const track = await response.json() as {
    id: string;
    name: string;
    artists: { id: string; name: string }[];
    album: { name: string; images?: { url: string }[]; release_date?: string; total_tracks?: number };
    duration_ms: number;
    track_number?: number;
  };

  const genres: string[] = [];
  const artistIds = (track.artists ?? []).map((a) => a.id).filter(Boolean).slice(0, 5);
  if (artistIds.length > 0) {
    try {
      const token2 = await getProviderToken();
      const artistRes = await fetch(`${PROVIDER_API_BASE}/artists?ids=${artistIds.join(',')}`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      if (artistRes.ok) {
        const artistData = await artistRes.json() as { artists: { genres?: string[] }[] };
        const seen = new Set<string>();
        for (const a of artistData.artists ?? []) {
          for (const g of a.genres ?? []) {
            if (!seen.has(g)) { seen.add(g); genres.push(g); }
          }
        }
      }
    } catch { /* genres remain empty */ }
  }

  const result = {
    trackId: track.id,
    name: stripHtml(track.name || ''),
    artist: stripHtml((track.artists ?? []).map((a) => a.name).join(', ')),
    album: stripHtml(track.album?.name || ''),
    duration: track.duration_ms,
    albumArt: track.album?.images?.[0]?.url || null,
    releaseYear: track.album?.release_date ? track.album.release_date.slice(0, 4) : null,
    totalTracks: track.album?.total_tracks ?? null,
    trackNumber: track.track_number ?? null,
    genres,
  };

  trackCache.put(trackId, result);
  return result;
}

async function searchTrackId(songName: string, artistName?: string): Promise<string | null> {
  const q = artistName?.trim()
    ? `track:${songName.trim()} artist:${artistName.trim()}`
    : songName.trim();

  const token = await getProviderToken();
  const params = new URLSearchParams({ q, type: 'track', limit: '1', market: 'US' });
  const res = await fetch(`${PROVIDER_API_BASE}/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return null;
  const data = await res.json() as { tracks?: { items?: { id: string }[] } };
  return data.tracks?.items?.[0]?.id ?? null;
}

async function fetchFallbackTrack(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  const apiKey = getEnv().LASTFM_API_KEY;
  if (!apiKey) return { error: 'No track metadata provider configured', status: 503 };

  try {
    const params = new URLSearchParams({
      method: 'track.getInfo',
      api_key: apiKey,
      track: songName.trim(),
      autocorrect: '1',
      format: 'json',
    });
    if (artistName?.trim()) {
      params.append('artist', artistName.trim());
    }

    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    if (!res.ok) return { error: 'Fallback metadata search failed', status: 502 };

    interface FallbackTag { name: string }
    interface FallbackTrackResponse {
      error?: number;
      track?: {
        mbid?: string;
        name?: string;
        duration?: string;
        artist?: { name?: string };
        album?: { title?: string };
        toptags?: { tag?: FallbackTag[] };
      };
    }
    const data = await res.json() as FallbackTrackResponse;
    if (!data || !data.track || data.error) return { error: 'No tracks found', status: 404 };

    const track = data.track;
    const genres = track.toptags?.tag?.map((t: FallbackTag) => t.name) || [];

    return {
      trackId: track.mbid || '',
      name: track.name || songName,
      artist: track.artist?.name || artistName || '',
      album: track.album?.title || '',
      albumArt: null,
      duration: track.duration ? parseInt(track.duration, 10) : 0,
      genres,
      totalTracks: null,
    };
  } catch (err) {
    console.error('[song-metadata] Fallback fetch error:', err);
    return { error: 'Failed to fetch fallback metadata', status: 500 };
  }
}

export async function lookupTrack(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;

  if (isProviderConfigured()) {
    try {
      const trackId = await searchTrackId(songName, artistName);
      if (trackId) {
        const details = await fetchTrackDetails(trackId);
        if (!details.error) {
          result = details;
          insertAutocompleteTerms(
            [result.name, result.artist].filter((v): v is string => typeof v === 'string' && v.length > 0)
          );
          return result;
        }
      }
    } catch (err) {
      console.error('[song-metadata] Primary lookup failed, falling back', err);
    }
  }

  result = await fetchFallbackTrack(songName, artistName);
  if (!result.error) {
    insertAutocompleteTerms(
      [result.name, result.artist].filter((v): v is string => typeof v === 'string' && v.length > 0)
    );
  }
  return result;
}
