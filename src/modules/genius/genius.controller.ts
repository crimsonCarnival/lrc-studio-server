import type { FastifyRequest, FastifyReply } from 'fastify';
import { getLyricsFromLrclib, getLrclibById, searchLrclib, LRCLIB_ID_PREFIX } from './lrclib.service.js';
import { getLyricsFromLyricFind } from './lyricfind.service.js';
import { getLyricsFromLyricsOvh } from './lyricsovh.service.js';
import type { LyricsResult } from './lyrics-provider.types.js';
import JobLog from '../../db/job-log.model.js';
import { auditActorId } from '../../plugins/auth.js';

/**
 * Search runs against LRCLIB, the same source `extract` resolves lyrics from. Search used to go
 * through Genius, whose catalogue is not the one the lyrics come from: a song that exists on
 * Genius but not on LRCLIB (or the later providers) showed up as a hit and then failed to import.
 * Searching the primary provider means every hit can actually be imported, and each one carries a
 * `synced` flag so the UI can show which come with timestamps. The hit id is `lrclib:<id>`, which
 * `extract` resolves back to that exact record.
 */
export async function search(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = (request.query as Record<string, string>).q;
  if (!query) {
    return reply.code(400).send({ error: 'Missing search query' });
  }

  try {
    return reply.send({ results: await searchLrclib(query) });
  } catch (err) {
    request.log.error({ err }, 'LRCLIB search failed');
    return reply.code(502).send({ error: 'upstream_error' });
  }
}

/**
 * Runs one provider, converting an upstream fault into a null so a single sick
 * provider degrades the chain instead of failing the whole request.
 */
async function tryProvider(
  request: FastifyRequest,
  name: string,
  run: () => Promise<LyricsResult | null>,
): Promise<LyricsResult | null> {
  try {
    return await run();
  } catch (err) {
    request.log.warn({ err, provider: name }, 'Lyrics provider failed, falling through');
    return null;
  }
}

/**
 * Provider chain, in order:
 *   1. LRCLIB     — free, keyless, and the only source that returns synced LRC.
 *   2. LyricFind  — licensed; skipped unless LYRICFIND_API_KEY is set.
 *   3. lyrics.ovh — free, keyless, plain text only; no fuzzy matching, so it
 *      only answers when the track/artist strings are already close to exact.
 *
 * A Musixmatch scraper used to sit at the end of this chain. It was removed:
 * it reverse-engineered a signing secret out of their web bundle, was verified
 * broken against the live API (signed requests return an empty body), and its
 * retry budget added a ~2 minute tail to every total miss.
 */
export async function extract(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const params = request.query as Record<string, string>;
  const track = params.track?.trim();
  const artist = params.artist?.trim() ?? '';
  const album = params.album?.trim() || undefined;
  const id = params.id?.trim();
  // Duration sharply improves LRCLIB's ability to tell a remaster, a live cut
  // and a cover apart. Optional — the client sends it only when media is loaded.
  const durationRaw = Number(params.duration);
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined;

  if (!track) {
    return reply.code(400).send({ error: 'Missing track parameter' });
  }

  const startedAt = Date.now();
  const actorId = await auditActorId(request);
  // What every task record carries, whether the lookup worked or not.
  const base = () => ({
    jobType: 'extract_lyrics' as const,
    userId: actorId,
    query: { track, artist, album },
    publicId: typeof params.publicId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(params.publicId) ? params.publicId : null,
    durationMs: Date.now() - startedAt,
    ip: request.ip,
    deviceId: typeof request.headers['x-device-id'] === 'string' ? request.headers['x-device-id'] : null,
  });

  try {
    let result: LyricsResult | null = null;

    // An LRCLIB-sourced search hit resolves back to the exact record the user
    // picked, instead of re-running a fuzzy match that might land elsewhere.
    if (id?.startsWith(LRCLIB_ID_PREFIX)) {
      const numericId = Number(id.slice(LRCLIB_ID_PREFIX.length));
      if (Number.isInteger(numericId)) {
        result = await tryProvider(request, 'lrclib', () => getLrclibById(numericId));
      }
    }

    result ??= await tryProvider(request, 'lrclib', () => getLyricsFromLrclib(track, artist, album, duration));
    result ??= await tryProvider(request, 'lyricfind', () => getLyricsFromLyricFind(track, artist));
    result ??= await tryProvider(request, 'lyricsovh', () => getLyricsFromLyricsOvh(track, artist));

    if (result) {
      await JobLog.create({
        ...base(),
        status: 'succeeded',
        provider: result.provider,
        synced: result.synced,
        lineCount: result.lyrics.split('\n').filter((l: string) => l.trim()).length,
      }).catch(() => {});
      return reply.send(result);
    }

    await JobLog.create({ ...base(), status: 'failed', error: 'lyrics_unavailable' }).catch(() => {});
    return reply.code(422).send({ error: 'lyrics_unavailable' });
  } catch (err) {
    request.log.error({ err }, 'Lyrics extract failed');
    await JobLog.create({ ...base(), status: 'failed', error: 'upstream_error' }).catch(() => {});
    return reply.code(502).send({ error: 'upstream_error' });
  }
}
