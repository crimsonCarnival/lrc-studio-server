import type { FastifyRequest, FastifyReply } from 'fastify';
import * as spotifyService from './spotify.service.js';
import * as spotifySearch from './spotify.search.js';
import * as spotifyPlayback from './spotify.playback.js';
import * as uploadService from '../uploads/uploads.service.js';

function callbackHtml(success: boolean, error?: string | null): string {
  const payload = JSON.stringify({ type: 'spotify-callback', success, error: error || null });
  return `<!DOCTYPE html><html><head><title>Spotify</title></head><body>
<script>if(window.opener){window.opener.postMessage(${JSON.stringify(payload).replace(/</g, '\\u003c')},'*')}window.close();</script>
<p>${success ? 'Connected! This window will close.' : `Error: ${error || 'Unknown'}`}</p>
</body></html>`;
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
  const state = spotifyService.generateSignedState(req.userId!);
  return reply.redirect(spotifyService.getAuthUrl(state));
}

export async function callback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) {
    return reply.type('text/html').send(callbackHtml(false, error));
  }

  if (!code || !state) {
    return reply.code(400).type('text/html').send(callbackHtml(false, 'Missing code or state'));
  }

  const userId = spotifyService.verifySignedState(state);
  if (!userId) {
    return reply.code(400).type('text/html').send(callbackHtml(false, 'Invalid or expired state'));
  }

  const result = await spotifyService.handleCallback(code, userId);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error));
  }

  return reply.type('text/html').send(callbackHtml(true));
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