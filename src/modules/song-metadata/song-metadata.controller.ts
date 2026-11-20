import type { FastifyRequest, FastifyReply } from 'fastify';
import * as songMetadataService from './song-metadata.service.js';

interface LookupQuery {
  songName?: string;
  artistName?: string;
  featured?: string[] | string;
}

function readQuery(req: FastifyRequest): { songName: string; artistName?: string; featuredArtists: string[] } {
  const { songName = '', artistName, featured } = req.query as LookupQuery;
  const list = Array.isArray(featured) ? featured : featured ? [featured] : [];
  return { songName, artistName, featuredArtists: list.map((f) => f.trim()).filter(Boolean) };
}

export async function search(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const q = readQuery(req);
  if (!q.songName.trim()) return reply.code(400).send({ error: 'songName is required' });
  const outcome = await songMetadataService.searchTracks(q);
  if ('error' in outcome) return reply.code(outcome.status).send({ error: outcome.error });
  return reply.send(outcome);
}

export async function lookup(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const q = readQuery(req);
  if (!q.songName.trim()) return reply.code(400).send({ error: 'songName is required' });
  const result = await songMetadataService.lookupTrack(q.songName, q.artistName, q.featuredArtists);
  if (result.error) {
    return reply.code((result.status as number) || 502).send({ error: result.error });
  }
  return reply.send(result);
}
