import type { FastifyRequest, FastifyReply } from 'fastify';
import * as songMetadataService from './song-metadata.service.js';
import { getAutocompleteSuggestions } from './autocomplete.trie.js';

export async function lookup(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { songName, artistName } = req.query as Record<string, string | undefined>;
  if (!songName?.trim()) return reply.code(400).send({ error: 'songName is required' });
  const result = await songMetadataService.lookupTrack(songName, artistName);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status || 502).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}

export async function autocomplete(
  req: FastifyRequest<{ Querystring: { q: string } }>,
  reply: FastifyReply
): Promise<void> {
  const suggestions = getAutocompleteSuggestions(req.query.q);
  reply.send({ suggestions });
}
