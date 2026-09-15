import type { FastifyRequest, FastifyReply } from 'fastify';
import { searchSongs } from './genius.service.js';
import { getLyricsForSong } from './musixmatch.service.js';
import JobLog from '../../db/job-log.model.js';

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
  const params = request.query as Record<string, string>;
  const track = params.track?.trim();
  const artist = params.artist?.trim() ?? '';

  if (!track) {
    return reply.code(400).send({ error: 'Missing track parameter' });
  }

  try {
    const lyrics = await getLyricsForSong(track, artist);
    if (lyrics) {
      await JobLog.create({ jobType: 'extract_lyrics', status: 'succeeded', userId: request.userId || null }).catch(() => {});
      return reply.send({ lyrics });
    }
    
    await JobLog.create({ jobType: 'extract_lyrics', status: 'failed', error: 'lyrics_unavailable', userId: request.userId || null }).catch(() => {});
    return reply.code(422).send({ error: 'lyrics_unavailable' });
  } catch (err) {
    request.log.error({ err }, 'Musixmatch extract failed');
    await JobLog.create({ jobType: 'extract_lyrics', status: 'failed', error: 'upstream_error', userId: request.userId || null }).catch(() => {});
    return reply.code(502).send({ error: 'upstream_error' });
  }
}
