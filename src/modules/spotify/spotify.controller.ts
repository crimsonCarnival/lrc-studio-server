import type { FastifyRequest, FastifyReply } from 'fastify';
import * as spotifyService from './spotify.service.js';
import * as spotifySearch from './spotify.search.js';
import * as spotifyPlayback from './spotify.playback.js';
import * as uploadService from '../uploads/uploads.service.js';
import * as authService from '../auth/auth.service.js';
import { getEnv } from '../../config/env.js';
import { jwtTools } from '../../plugins/auth.js';

function callbackHtml(success: boolean, error?: string | null, appOrigin?: string | null): string {
  const payload = { type: 'spotify-callback', success, error: error || null };
  const payloadStr = JSON.stringify(payload).replace(/</g, '\\u003c');
  const target = JSON.stringify(appOrigin || getEnv().APP_URL);
  const redirectBase = appOrigin || getEnv().APP_URL;
  const redirectUrl = success
    ? `${redirectBase}/auth/signin?scb=success`
    : `${redirectBase}/auth/signin?scb=error&scb_msg=${encodeURIComponent(error || 'OAuth failed')}`;
  return `<!DOCTYPE html><html><head><title>Spotify</title></head><body>
<script>
  if (window.opener) {
    window.opener.postMessage(${payloadStr}, ${target});
    window.close();
  } else {
    window.location.replace(${JSON.stringify(redirectUrl)});
  }
</script>
<p>${success ? 'Connected! Redirecting...' : `Error: ${error || 'Unknown'}`}</p>
</body></html>`;
}

function resolveAppOrigin(requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const env = getEnv();
  const allowed = new Set([
    ...env.APP_URLS.map(u => new URL(u).origin),
    new URL(env.CORS_ORIGIN.split(',')[0].trim()).origin,
  ]);
  try { return allowed.has(new URL(requested).origin) ? new URL(requested).origin : undefined; } catch { return undefined; }
}

export async function lookup(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { songName, artistName } = req.query as Record<string, string | undefined>;
  if (!songName?.trim()) return reply.code(400).send({ error: 'songName is required' });
  const result = await spotifyService.lookupTrack(songName, artistName);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status || 502).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}

export async function resolve(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyService.resolveTrack((req.body as Record<string, string>).url);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}

export async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!spotifyService.isSpotifyConfigured()) {
    return reply.code(503).send({ error: 'Spotify integration not configured' });
  }
  const { appOrigin: rawOrigin } = req.query as Record<string, string | undefined>;
  const appOrigin = resolveAppOrigin(rawOrigin);
  const state = spotifyService.generateSignedState({ sub: req.userId!, action: 'connect', appOrigin });
  reply.header('Cache-Control', 'no-store');
  return reply.redirect(spotifyService.getAuthUrl(state));
}

export async function authorizeLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!spotifyService.isSpotifyConfigured()) {
    return reply.code(503).send({ error: 'Spotify integration not configured' });
  }
  const { appOrigin: rawOrigin, deviceId: rawDeviceId } = req.query as Record<string, string | undefined>;
  const appOrigin = resolveAppOrigin(rawOrigin);
  const deviceId = typeof rawDeviceId === 'string' && rawDeviceId.trim().length > 0 ? rawDeviceId.trim().slice(0, 256) : undefined;
  const state = spotifyService.generateSignedState({ action: 'login', appOrigin, deviceId });
  reply.header('Cache-Control', 'no-store');
  return reply.redirect(spotifyService.getAuthUrl(state));
}

export async function callback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // In local dev, Spotify only allows 127.0.0.1 as a redirect URI, but the rest
  // of the stack (cookies, postMessage origin) expects localhost. Redirect the
  // popup from 127.0.0.1 → localhost so cookies and postMessage both work.
  if (process.env.NODE_ENV !== 'production' && req.hostname === '127.0.0.1') {
    const port = (req.headers.host ?? '').split(':')[1] ?? process.env.PORT ?? '3000';
    const { code, state, error } = req.query as Record<string, string | undefined>;
    const params = new URLSearchParams();
    if (code) params.set('code', code);
    if (state) params.set('state', state);
    if (error) params.set('error', error);
    return reply.redirect(`http://localhost:${port}/spotify/auth/callback?${params}`);
  }

  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) {
    return reply.type('text/html').send(callbackHtml(false, error));
  }

  if (!code || !state) {
    return reply.code(400).type('text/html').send(callbackHtml(false, 'Missing code or state'));
  }

  const statePayload = spotifyService.verifySignedState(state);
  if (!statePayload) {
    return reply.code(400).type('text/html').send(callbackHtml(false, 'Invalid or expired state'));
  }

  const action = statePayload.action as string;
  const appOrigin = statePayload.appOrigin as string | undefined;

  if (action === 'connect' || !action) {
    const userId = (statePayload.sub as string) || (statePayload as unknown as string);
    const result = await spotifyService.handleCallback(code, userId);
    if ((result as Record<string, unknown>).error) {
      return reply.code((result as Record<string, number>).status || 400).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error, appOrigin));
    }
    return reply.type('text/html').send(callbackHtml(true, null, appOrigin));
  }

  if (action === 'login') {
    const result = await spotifyService.handleLoginCallback(code);
    if ((result as Record<string, unknown>).error) {
      return reply.code((result as Record<string, number>).status || 400).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error, appOrigin));
    }

    const userId = (result as Record<string, unknown>).userId as string;
    const deviceId = (statePayload.deviceId as string | undefined) || 'unknown';
    const userAgent = (req.headers['user-agent'] as string) || '';
    const platformVersion = (req.headers['sec-ch-ua-platform-version'] as string) || undefined;

    const tokens = await authService.loginByUserId(userId, jwtTools, req.ip, deviceId, userAgent, platformVersion);
    const tokensResult = tokens as Record<string, unknown> | null;
    
    if (!tokensResult || tokensResult.error) {
      return reply.code(500).type('text/html').send(callbackHtml(false, (tokensResult?.error as string) || 'Failed to create session', appOrigin));
    }

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    };

    reply.setCookie('accessToken', tokensResult.accessToken as string, cookieOpts);
    reply.setCookie('refreshToken', tokensResult.refreshToken as string, cookieOpts);

    return reply.type('text/html').send(callbackHtml(true, null, appOrigin));
  }

  return reply.code(400).type('text/html').send(callbackHtml(false, 'Invalid action', appOrigin));
}

export async function getToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyService.getValidSpotifyToken(req.userId!);
  if (typeof result === 'object' && (result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send({ accessToken: result });
}

export async function disconnect(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyService.disconnectSpotify(req.userId!);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}

export async function createUpload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const resolved = await spotifyService.resolveTrack((req.body as Record<string, string>).url);
  if ((resolved as Record<string, unknown>).error) {
    return reply.code((resolved as Record<string, number>).status).send({ error: (resolved as Record<string, unknown>).error });
  }

  const upload = await uploadService.createMedia(req.userId!, {
    source: 'spotify',
    spotifyTrackId: (resolved as Record<string, unknown>).trackId as string,
    title: (resolved as Record<string, unknown>).name as string,
    artist: (resolved as Record<string, unknown>).artist as string,
    duration: (resolved as Record<string, unknown>).duration ? ((resolved as Record<string, number>).duration / 1000) : null,
    fileName: '',
    coverImage: (resolved as Record<string, unknown>).albumArt as string | null,
  });

  return reply.send({ ...upload, trackMeta: resolved });
}

export async function searchTracks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { q, limit, offset } = req.query as Record<string, string | undefined>;
  const result = await spotifySearch.search(req.userId!, q as string, limit as unknown as number, offset as unknown as number);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function savedTracks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { limit, offset } = req.query as Record<string, string | undefined>;
  const result = await spotifySearch.getSavedTracks(req.userId!, limit as unknown as number, offset as unknown as number);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function recentlyPlayed(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { limit } = req.query as Record<string, string | undefined>;
  const result = await spotifySearch.getRecentlyPlayed(req.userId!, limit as unknown as number);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function topTracks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { time_range, limit, offset } = req.query as Record<string, string | undefined>;
  const result = await spotifySearch.getTopTracks(req.userId!, time_range, limit as unknown as number, offset as unknown as number);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function playlists(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { limit, offset } = req.query as Record<string, string | undefined>;
  const result = await spotifySearch.getMyPlaylists(req.userId!, limit as unknown as number, offset as unknown as number);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function playlistTracks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { playlistId } = req.params as Record<string, string>;
  const { limit, offset } = req.query as Record<string, string | undefined>;
  const result = await spotifySearch.getPlaylistTracks(req.userId!, playlistId, limit as unknown as number, offset as unknown as number);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function createPlaylist(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { name, description, public: isPublic } = req.body as Record<string, unknown>;
  const result = await spotifySearch.createPlaylist(req.userId!, name as string, description as string, isPublic as boolean);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function addToPlaylist(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { playlistId } = req.params as Record<string, string>;
  const { uris } = req.body as Record<string, unknown>;
  const result = await spotifySearch.addToPlaylist(req.userId!, playlistId, uris as string[]);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function saveToLibrary(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { uris } = req.body as Record<string, unknown>;
  const result = await spotifySearch.saveToLibrary(req.userId!, uris as string[]);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function removeFromLibrary(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { uris } = req.body as Record<string, unknown>;
  const result = await spotifySearch.removeFromLibrary(req.userId!, uris as string[]);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function checkLibrary(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { uris } = req.query as Record<string, string>;
  const uriList = uris ? uris.split(',') : [];
  const result = await spotifySearch.checkLibrary(req.userId!, uriList);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function devices(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyPlayback.getDevices(req.userId!);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function transferPlayback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { deviceId, play } = req.body as Record<string, unknown>;
  const result = await spotifyPlayback.transferPlayback(req.userId!, deviceId as string, play as boolean);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function playbackState(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyPlayback.getPlaybackState(req.userId!);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function currentlyPlaying(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyPlayback.getCurrentlyPlaying(req.userId!);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function addToQueue(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { uri, deviceId } = req.body as Record<string, unknown>;
  const result = await spotifyPlayback.addToQueue(req.userId!, uri as string, deviceId as string);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function getQueue(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await spotifyPlayback.getQueue(req.userId!);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}