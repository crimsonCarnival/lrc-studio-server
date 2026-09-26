import type { FastifyRequest, FastifyReply } from 'fastify';
import { searchSongs } from './genius.service.js';
import { getLyricsFromLrclib, getLrclibById, searchLrclib, LRCLIB_ID_PREFIX } from './lrclib.service.js';
import { getLyricsFromLyricFind } from './lyricfind.service.js';
import { getLyricsFromLyricsOvh } from './lyricsovh.service.js';
import type { LyricsResult, LyricsSearchHit } from './lyrics-provider.types.js';
import JobLog from '../../db/job-log.model.js';

/**
 * Search uses Genius when configured — it has cover art and the best fuzzy
 * matching — and falls back to LRCLIB otherwise, so the feature works on a
 * deployment with no API keys at all. LRCLIB hits additionally carry a `synced`
 * flag so the UI can show which results come with timestamps.
 */
export async function search(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const query = (request.query as Record<string, string>).q;
  if (!query) {
    return reply.code(400).send({ error: 'Missing search query' });
  }

  let geniusFailure: (Error & { retryAfter?: string }) | null = null;
  try {
    const hits = await searchSongs(query);
    if (hits.length) {
      const results: LyricsSearchHit[] = hits.map(h => ({
        id: String(h.id),
        title: h.title,
        artist: h.artist,
        thumbnail: h.thumbnail,
        url: h.url,
        provider: 'genius' as const,
      }));
      return reply.send({ results });
    }
    // Genius configured but empty-handed — LRCLIB's catalogue differs enough
    // to be worth a second look before telling the user there's nothing.
  } catch (err) {
    geniusFailure = err as Error & { retryAfter?: string };
  }

  try {
    const results = await searchLrclib(query);
    if (results.length || !geniusFailure) return reply.send({ results });
  } catch (err) {
    request.log.error({ err }, 'LRCLIB search failed');
  }

  if (geniusFailure?.message === 'genius_not_configured') {
    return reply.code(500).send({ error: 'genius_not_configured' });
  }
  if (geniusFailure?.message === 'rate_limited') {
    return reply.code(429).send({ error: 'rate_limited', retryAfter: geniusFailure.retryAfter });
  }
  request.log.error({ err: geniusFailure }, 'Lyrics search failed');
  return reply.code(502).send({ error: 'upstream_error' });
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
      await JobLog.create({ jobType: 'extract_lyrics', status: 'succeeded', userId: request.userId || null }).catch(() => {});
      return reply.send(result);
    }

    await JobLog.create({ jobType: 'extract_lyrics', status: 'failed', error: 'lyrics_unavailable', userId: request.userId || null }).catch(() => {});
    return reply.code(422).send({ error: 'lyrics_unavailable' });
  } catch (err) {
    request.log.error({ err }, 'Lyrics extract failed');
    await JobLog.create({ jobType: 'extract_lyrics', status: 'failed', error: 'upstream_error', userId: request.userId || null }).catch(() => {});
    return reply.code(502).send({ error: 'upstream_error' });
  }
}
