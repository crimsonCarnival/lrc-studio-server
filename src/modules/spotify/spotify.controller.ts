import type { FastifyRequest, FastifyReply } from 'fastify';
import * as spotifyService from './spotify.service.js';
import * as uploadService from '../uploads/uploads.service.js';

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
