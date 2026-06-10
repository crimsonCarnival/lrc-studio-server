import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { stripHtml } from '../../utils/sanitize.js';
import User from '../../db/user.model.js';
import { LRUCache } from '@crimson-carnival/ds-js';
import { sendVerification } from '../email-verification/email-verification.service.js';
import { createOnce } from '../notifications/notifications.service.js';
import { triggerBadgeCheck, seedBuiltinBadges } from '../badges/badge.service.js';

interface SpotifyStatePayload {
  sub?: string;
  action?: string;
  appOrigin?: string;
  deviceId?: string;
  nonce?: string;
}

/**
 * Signing key for the OAuth `state` JWT — kept separate from the session JWT
 * secret so state and session tokens can't be confused. Mirrors google.service. (F4)
 */
function getStateSecret(): string {
  if (process.env.OAUTH_STATE_SECRET) return process.env.OAUTH_STATE_SECRET;
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'change-me')
    .update('oauth-state-v1')
    .digest('hex');
}

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const TRACK_URL_RE = /(?:spotify\.com\/track\/|spotify:track:)([a-zA-Z0-9]{22})/;

const trackCache = new LRUCache(100);

const SCOPES = [
  'user-read-private',
  'user-read-email',
  'streaming',
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-recently-played',
  'user-read-currently-playing',
  'user-library-read',
  'user-library-modify',
  'user-top-read',
  'user-follow-read',
  'user-follow-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
];

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function getClientId() { return process.env.SPOTIFY_CLIENT_ID; }
function getClientSecret() { return process.env.SPOTIFY_CLIENT_SECRET; }
function getRedirectUri() { return process.env.SPOTIFY_REDIRECT_URI; }
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

export function generateSignedState(payload: string | SpotifyStatePayload): string {
  const data = typeof payload === 'string' ? { sub: payload } : payload;
  return jwt.sign(
    { ...data, nonce: crypto.randomBytes(8).toString('hex') },
    getStateSecret(),
    { expiresIn: '5m' },
  );
}

export function verifySignedState(state: string): SpotifyStatePayload | null {
  try {
    const decoded = jwt.verify(state, getStateSecret()) as SpotifyStatePayload;
    return decoded;
  } catch {
    return null;
  }
}

export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId() || '',
    scope: SCOPES.join(' '),
    redirect_uri: getRedirectUri() || '',
    state,
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

export async function handleCallback(code: string, userId: string): Promise<Record<string, unknown>> {
  const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri() || '',
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({})) as Record<string, string>;
    return { error: body.error_description || 'Token exchange failed', status: 400 };
  }

  const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };

  const profileRes = await fetch(`${SPOTIFY_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileRes.ok) {
    return { error: 'Failed to fetch Spotify profile', status: 502 };
  }

  const profile = await profileRes.json() as { id: string; images?: { url: string }[] };

  const profilePictureUrl = profile.images && profile.images.length > 0
    ? profile.images[0].url
    : null;

  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  user.spotify = {
    spotifyId: profile.id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    isPremium: true,
    profilePictureUrl,
  };
  await user.save();

  return {
    connected: true,
    spotifyId: profile.id,
    isPremium: true,
  };
}

export async function handleLoginCallback(code: string): Promise<Record<string, unknown>> {
  const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getRedirectUri() || '',
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({})) as Record<string, string>;
    return { error: body.error_description || 'Token exchange failed', status: 400 };
  }

  const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in: number };

  const profileRes = await fetch(`${SPOTIFY_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!profileRes.ok) {
    return { error: 'Failed to fetch Spotify profile', status: 502 };
  }

  const profile = await profileRes.json() as { id: string; display_name?: string; email?: string; images?: { url: string }[] };

  const profilePictureUrl = profile.images && profile.images.length > 0
    ? profile.images[0].url
    : null;

  const spotifyId = profile.id;
  const email = profile.email || `${spotifyId}@spotify.placeholder.com`;
  const name = profile.display_name || 'Spotify User';

  let user = await User.findOne({ 'spotify.spotifyId': spotifyId });

  if (!user) {
    // If no user by spotifyId, try email
    const existingEmailUser = await User.findOne({ email });
    if (existingEmailUser) {
      user = existingEmailUser;
      if (!user.spotify) user.spotify = {} as NonNullable<typeof user.spotify>;
      user.spotify!.spotifyId = spotifyId;
      user.spotify!.accessToken = tokens.access_token;
      user.spotify!.refreshToken = tokens.refresh_token;
      user.spotify!.expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
      user.spotify!.isPremium = true;
      user.spotify!.profilePictureUrl = profilePictureUrl;
      
      if (!user.avatarUrl && profilePictureUrl) user.avatarUrl = profilePictureUrl;
      const wasVerified = user.isVerified;
      user.isVerified = true; // Spotify emails are verified
      await user.save();
      
      if (!wasVerified) {
        triggerBadgeCheck(user._id.toString(), 'email_verified').catch(() => {});
      }
    } else {
      // Auto-generate accountName
      const nameBase = (name || 'user')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 22);
      const base = nameBase || 'user';

      let accountName = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
      let attempt = 0;
      while (await User.findOne({ accountName }) && attempt < 10) {
        accountName = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
        attempt++;
      }

      user = new User({
        accountName,
        displayName: name || accountName,
        email,
        avatarUrl: profilePictureUrl || undefined,
        passwordHash: 'OAUTH_NO_PASSWORD',
        isVerified: true, // Spotify verifies email
        spotify: {
          spotifyId,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          isPremium: true,
          profilePictureUrl,
        },
      });
      await user.save();
      
      // Seed badges for new user
      if (user.email && !user.email.endsWith('@spotify.placeholder.com')) {
        sendVerification(user._id.toString(), user.email, 'initial').catch((e) => console.error('[spotify] sendVerification failed:', e));
      }
      createOnce({ userId: user._id.toString(), type: 'set_password', sticky: true }).catch(() => {});
      seedBuiltinBadges()
        .then(() => triggerBadgeCheck(user!._id.toString(), 'registration'))
        .catch(() => {});
    }
  } else {
    user.spotify!.accessToken = tokens.access_token;
    user.spotify!.refreshToken = tokens.refresh_token;
    user.spotify!.expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    user.spotify!.profilePictureUrl = profilePictureUrl;
    await user.save();
  }

  return {
    userId: user._id.toString(),
    spotifyId,
    email,
    name,
  };
}

export async function getValidSpotifyToken(userId: string): Promise<string | Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (!user.spotify?.refreshToken) return { error: 'Spotify not connected', status: 400 };

  if (user.spotify.accessToken && user.spotify.expiresAt && new Date(user.spotify.expiresAt) > new Date(Date.now() + 60_000)) {
    return user.spotify.accessToken;
  }

  const refreshRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.spotify.refreshToken,
    }).toString(),
  });

  if (!refreshRes.ok) {
    user.spotify.accessToken = null as unknown as string;
    user.spotify.expiresAt = null as unknown as Date;
    await user.save();
    return { error: 'Spotify token refresh failed — please reconnect', status: 401 };
  }

  const data = await refreshRes.json() as { access_token: string; expires_in: number; refresh_token?: string };

  user.spotify.accessToken = data.access_token;
  user.spotify.expiresAt = new Date(Date.now() + data.expires_in * 1000);
  if (data.refresh_token) {
    user.spotify.refreshToken = data.refresh_token;
  }
  await user.save();

  return data.access_token;
}

export async function disconnectSpotify(userId: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  const Upload = (await import('../uploads/upload.model.js')).default;
  await Upload.deleteMany({ userId, source: 'spotify' });

  user.spotify = {
    spotifyId: null,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    isPremium: false,
    profilePictureUrl: null,
  } as unknown as typeof user.spotify;
  await user.save();

  return { disconnected: true };
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

  // Fetch artist genres with same client-credentials token
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

export async function spotifyFetch(userId: string, path: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const token = await getValidSpotifyToken(userId);
  if (typeof token === 'object' && (token as Record<string, unknown>).error) return token;

  const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...((options.body as string) ? { 'Content-Type': 'application/json' } : {}),
      ...((options.headers as Record<string, string>) || {}),
    },
  } as RequestInit);

  if (res.status === 204) return { ok: true };
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.status === 403 || (res.status === 401 && (body as Record<string, { message?: string }>)?.error?.message?.toLowerCase().includes('scope'))) {
      return { error: 'spotify_scope_error', message: (body as Record<string, { message?: string }>).error?.message || 'Insufficient Spotify permissions. Please disconnect and reconnect Spotify to grant the required scopes.', status: 403 };
    }
    return { error: (body as Record<string, { message?: string }>).error?.message || `Spotify API error: ${res.status}`, status: res.status };
  }

  return res.json() as Promise<Record<string, unknown>>;
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
