import type { FastifyRequest, FastifyReply } from 'fastify';
import { searchSongs, extractLyrics } from './genius.service.js';
import { getLyricsForSong } from './musixmatch.service.js';

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
  const query = request.query as Record<string, string>;
  const url = query.url;
  const track = query.track;
  const artist = query.artist;

  if (!url) {
    return reply.code(400).send({ error: 'Missing url parameter' });
  }

  try {
    new URL(url); // validate URL format
  } catch {
    return reply.code(400).send({ error: 'Invalid url' });
  }

  // Try Musixmatch first when title+artist are available (avoids cloud-IP scraping)
  if (track && artist) {
    try {
      const lyrics = await getLyricsForSong(track, artist);
      if (lyrics) return reply.send({ lyrics });
    } catch (err) {
      request.log.warn({ err }, 'Musixmatch extract failed, falling back to Genius');
    }
  }

  try {
    const lyrics = await extractLyrics(url);
    return reply.send({ lyrics });
  } catch (err) {
    const error = err as Error & { statusCode?: number };
    if (error.message === 'invalid_url') {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    if (error.message === 'lyrics_unavailable') {
      return reply.code(422).send({ error: 'lyrics_unavailable' });
    }
    request.log.error({ err: error, geniusStatus: error.statusCode }, 'Genius extract failed');
    return reply.code(502).send({ error: 'upstream_error' });
  }
}
