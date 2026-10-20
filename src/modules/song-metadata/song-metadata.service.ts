import { getEnv } from '../../config/env.js';
import { stripHtml } from '../../utils/sanitize.js';
import { LRUCache } from '@crimson-carnival/ds-js';

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
    preview_url?: string | null;
    explicit?: boolean;
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
    previewUrl: track.preview_url || null,
    explicit: !!track.explicit,
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

async function fetchFromItunes(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  try {
    const term = artistName?.trim() ? `${songName.trim()} ${artistName.trim()}` : songName.trim();
    const params = new URLSearchParams({ term, entity: 'song', limit: '1', country: 'US' });
    const res = await fetch(`https://itunes.apple.com/search?${params}`);
    if (!res.ok) return { error: 'iTunes metadata search failed', status: 502 };

    const data = await res.json() as ITunesSearchResponse;
    const track = data.results?.[0];
    if (!track) return { error: 'No tracks found', status: 404 };

    return {
      trackId: track.trackId != null ? String(track.trackId) : '',
      name: stripHtml(track.trackName || songName),
      artist: stripHtml(track.artistName || artistName || ''),
      album: stripHtml(track.collectionName || ''),
      duration: track.trackTimeMillis ?? 0,
      albumArt: track.artworkUrl100 ? track.artworkUrl100.replace('100x100', '600x600') : null,
      releaseYear: track.releaseDate ? track.releaseDate.slice(0, 4) : null,
      totalTracks: track.trackCount ?? null,
      trackNumber: track.trackNumber ?? null,
      previewUrl: track.previewUrl || null,
      explicit: track.trackExplicitness === 'explicit',
      genres: track.primaryGenreName ? [track.primaryGenreName] : [],
    };
  } catch (err) {
    console.error('[song-metadata] iTunes fetch error:', err);
    return { error: 'Failed to fetch iTunes metadata', status: 500 };
  }
}

interface DeezerSearchResponse {
  data?: {
    id?: number;
    title?: string;
    artist?: { name?: string };
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

async function fetchFromDeezer(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  try {
    const q = artistName?.trim() ? `${songName.trim()} ${artistName.trim()}` : songName.trim();
    const res = await fetch(`https://api.deezer.com/search?${new URLSearchParams({ q, limit: '1' })}`);
    if (!res.ok) return { error: 'Deezer metadata search failed', status: 502 };

    const data = await res.json() as DeezerSearchResponse;
    const track = data.data?.[0];
    if (!track) return { error: 'No tracks found', status: 404 };

    let releaseYear: string | null = null;
    let totalTracks: number | null = null;
    let genres: string[] = [];
    if (track.album?.id) {
      try {
        const albumRes = await fetch(`https://api.deezer.com/album/${track.album.id}`);
        if (albumRes.ok) {
          const album = await albumRes.json() as DeezerAlbumResponse;
          releaseYear = album.release_date ? album.release_date.slice(0, 4) : null;
          totalTracks = album.nb_tracks ?? null;
          genres = (album.genres?.data ?? []).map((g) => g.name).filter((n): n is string => !!n);
        }
      } catch { /* album extras remain empty */ }
    }

    return {
      trackId: track.id != null ? String(track.id) : '',
      name: stripHtml(track.title || songName),
      artist: stripHtml(track.artist?.name || artistName || ''),
      album: stripHtml(track.album?.title || ''),
      duration: track.duration ? track.duration * 1000 : 0,
      albumArt: track.album?.cover_big || null,
      releaseYear,
      totalTracks,
      trackNumber: null,
      previewUrl: track.preview || null,
      explicit: !!track.explicit_lyrics,
      genres,
    };
  } catch (err) {
    console.error('[song-metadata] Deezer fetch error:', err);
    return { error: 'Failed to fetch Deezer metadata', status: 500 };
  }
}

export async function lookupTrack(songName: string, artistName?: string): Promise<Record<string, unknown>> {
  if (isProviderConfigured()) {
    try {
      const trackId = await searchTrackId(songName, artistName);
      if (trackId) {
        const details = await fetchTrackDetails(trackId);
        if (!details.error) return details;
      }
    } catch (err) {
      console.error('[song-metadata] Primary lookup failed, falling back', err);
    }
  }

  const fromItunes = await fetchFromItunes(songName, artistName);
  if (!fromItunes.error) return fromItunes;

  return await fetchFromDeezer(songName, artistName);
}
