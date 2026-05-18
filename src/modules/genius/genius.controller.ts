import type { FastifyRequest, FastifyReply } from 'fastify';
import { searchSongs, extractLyrics } from './genius.service.js';

export async function search(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = (request.query as Record<string, string>).q;
  if (!query) {
    return reply.code(400).send({ error: 'Missing search query' });
  }

  try {
    const results = await searchSongs(query);
    return reply.send({ results });
  } catch (err) {
    const error = err as Error & { retryAfter?: string };
    if (error.message === 'genius_not_configured') {
      return reply.code(500).send({ error: 'genius_not_configured' });
    }
    if (error.message === 'rate_limited') {
      return reply.code(429).send({ error: 'rate_limited', retryAfter: error.retryAfter });
    }
    request.log.error(error);
    return reply.code(502).send({ error: 'upstream_error' });
  }
}

export async function extract(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const url = (request.query as Record<string, string>).url;
  if (!url) {
    return reply.code(400).send({ error: 'Missing url parameter' });
  }

  try {
    new URL(url); // validate URL format
  } catch {
    return reply.code(400).send({ error: 'Invalid url' });
  }

  try {
    const lyrics = await extractLyrics(url);
    return reply.send({ lyrics });
  } catch (err) {
    const error = err as Error;
    if (error.message === 'invalid_url') {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    if (error.message === 'lyrics_unavailable') {
      return reply.code(422).send({ error: 'lyrics_unavailable' });
    }
    request.log.error(error);
    return reply.code(502).send({ error: 'upstream_error' });
  }
}
