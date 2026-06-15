import { stripHtml } from '../../utils/sanitize.js';
import { LRUCache } from '@crimson-carnival/ds-js';

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const TRACK_URL_RE = /(?:spotify\.com\/track\/|spotify:track:)([a-zA-Z0-9]{22})/;

const trackCache = new LRUCache(100);

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function getClientId() { return process.env.SPOTIFY_CLIENT_ID; }
function getClientSecret() { return process.env.SPOTIFY_CLIENT_SECRET; }
function basicAuth() {
  return `Basic ${Buffer.from(`${getClientId()}:${getClientSecret()}`).toString('base64')}`;
}

export function isSpotifyConfigured(): boolean {
  return !!(getClientId() && getClientSecret());
}

async function getClientToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

export function extractTrackId(url: string): string | null {
  const match = url?.match(TRACK_URL_RE);
  return match ? match[1] : null;
}

export async function resolveTrack(url: string): Promise<Record<string, unknown>> {
  if (!isSpotifyConfigured()) {
    return { error: 'Spotify integration not configured', status: 503 };
  }

  const trackId = extractTrackId(url);
  if (!trackId) {
    return { error: 'Invalid Spotify track URL', status: 400 };
  }

  const cached = trackCache.get(trackId) as Record<string, unknown> | undefined;
  if (cached) return cached;

  const token = await getClientToken();
  const response = await fetch(`${SPOTIFY_API_BASE}/tracks/${encodeURIComponent(trackId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 404) return { error: 'Track not found on Spotify', status: 404 };
    return { error: 'Spotify API request failed', status: 502 };
  }

  const track = await response.json() as {
    id: string;
    name: string;
    artists: { id: string; name: string }[];
    album: { name: string; images?: { url: string }[]; release_date?: string; total_tracks?: number };
    duration_ms: number;
    track_number?: number;
    preview_url?: string | null;
    uri: string;
  };

  const genres: string[] = [];
  const artistIds = (track.artists ?? []).map((a) => a.id).filter(Boolean).slice(0, 5);
  if (artistIds.length > 0) {
    try {
      const artistRes = await fetch(`${SPOTIFY_API_BASE}/artists?ids=${artistIds.join(',')}`, {
        headers: { Authorization: `Bearer ${token}` },
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
    previewUrl: track.preview_url || null,
    albumArt: track.album?.images?.[0]?.url || null,
    releaseYear: track.album?.release_date ? track.album.release_date.slice(0, 4) : null,
    totalTracks: track.album?.total_tracks ?? null,
    trackNumber: track.track_number ?? null,
    genres,
  };

  trackCache.put(trackId, result);
  return result;
}

export async function fetchLastFmTrack(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return { error: 'Last.fm API key not configured', status: 503 };

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
    if (!res.ok) return { error: 'Last.fm search failed', status: 502 };

    interface LastFmTag { name: string }
    interface LastFmTrackResponse {
      error?: number;
      track?: {
        mbid?: string;
        name?: string;
        duration?: string;
        artist?: { name?: string };
        album?: { title?: string };
        toptags?: { tag?: LastFmTag[] };
      };
    }
    const data = await res.json() as LastFmTrackResponse;
    if (!data || !data.track || data.error) return { error: 'No tracks found on Last.fm', status: 404 };

    const track = data.track;
    const genres = track.toptags?.tag?.map((t: LastFmTag) => t.name) || [];

    return {
      trackId: track.mbid || '',
      name: track.name || songName,
      artist: track.artist?.name || artistName || '',
      album: track.album?.title || '',
      albumArt: '',
      durationMs: track.duration ? parseInt(track.duration, 10) : 0,
      genres,
      totalTracks: 0,
    };
  } catch (err) {
    console.error('[LastFM] Fetch error:', err);
    return { error: 'Failed to fetch from Last.fm', status: 500 };
  }
}

export async function lookupTrack(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  if (isSpotifyConfigured()) {
    try {
      const q = artistName?.trim()
        ? `track:${songName.trim()} artist:${artistName.trim()}`
        : songName.trim();

      const token = await getClientToken();
      const params = new URLSearchParams({ q, type: 'track', limit: '1', market: 'US' });
      const res = await fetch(`${SPOTIFY_API_BASE}/search?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json() as { tracks?: { items?: { id: string }[] } };
        const first = data.tracks?.items?.[0];
        if (first) {
          return resolveTrack(`spotify:track:${first.id}`);
        }
      }
    } catch (err) {
      console.error('[Spotify] lookupTrack failed, falling back to Last.fm', err);
    }
  }

  return fetchLastFmTrack(songName, artistName);
}

export function normalizeTrack(track: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!track) return null;
  return {
    trackId: (track as Record<string, unknown>).id,
    name: stripHtml(((track as Record<string, unknown>).name as string) || ''),
    artist: stripHtml(((track as Record<string, { name: string }[]>).artists)?.map((a: { name: string }) => a.name).join(', ') || ''),
    album: stripHtml(((track as Record<string, { name: string }>).album)?.name || ''),
    duration: (track as Record<string, unknown>).duration_ms,
    albumArt: ((track as Record<string, { images?: { url: string }[] }>).album)?.images?.[0]?.url || null,
    uri: (track as Record<string, unknown>).uri,
  };
}
