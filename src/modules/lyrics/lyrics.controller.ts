import type { FastifyRequest, FastifyReply } from 'fastify';
import type { LineEntry } from '../../types/index.js';
import JobLog from '../../db/job-log.model.js';
import Settings from '../settings/settings.model.js';
import { auditActorId } from '../../plugins/auth.js';

import {
  parseLrcSrtFile,
  parseLrcMetaTags,
  buildLrcExportMetadata,
  compileLRC,
  inferEndTimes,
} from '../../utils/lrc.js';

import { compileSRT } from '../../utils/srt.js';
import { parseArtists, formatArtistDisplay } from '../../utils/artists.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

export async function parse(req: FastifyRequest, reply: FastifyReply) {
  const { content, filename, options } = req.body as Body;

  if (!content || typeof content !== 'string') {
    return reply.code(400).send({ error: 'Lyrics content is required' });
  }

  const normalizedName = ((filename as string) || 'lyrics.lrc').toLowerCase();
  if (!normalizedName.endsWith('.lrc') && !normalizedName.endsWith('.srt') && !normalizedName.endsWith('.txt')) {
    return reply.code(400).send({ error: 'Unsupported lyrics format' });
  }

  const lines = parseLrcSrtFile(content, filename as string, options && typeof options === 'object' ? options : {});
  // Header tags ([ti:], [ar:], …) and what the shared parser makes of them, so the
  // client can prefill artists and a cleaned title. SRT has no header tags.
  const isSrt = normalizedName.endsWith('.srt');
  const metadata = isSrt ? {} : parseLrcMetaTags(content);
  const parsed = metadata.ar || metadata.ti ? parseArtists(metadata.ar ?? '', metadata.ti) : null;
  return reply.send({
    lines,
    detectedFormat: filename?.toLowerCase().endsWith('.srt') ? 'srt' : 'lrc',
    count: lines.length,
    metadata,
    artists: parsed && {
      credits: parsed.credits,
      title: parsed.title,
      flags: parsed.flags,
      display: formatArtistDisplay(parsed.credits),
    },
  });
}

/**
 * An explicit `includeFeaturedInTitle` in the body always wins. When it is
 * omitted, a signed-in user's saved export setting decides; everyone else gets
 * false. The lookup only happens when it could matter (featured credits sent).
 */
async function resolveIncludeFeaturedInTitle(req: FastifyRequest, fromBody: unknown, metadata: Body): Promise<boolean> {
  if (typeof fromBody === 'boolean') return fromBody;
  const userId = (req as FastifyRequest & { userId?: string }).userId;
  const artists = (metadata as { artists?: unknown }).artists;
  const hasFeatured = Array.isArray(artists) && artists.some((a) => (a as { role?: unknown })?.role === 'featured');
  if (!userId || !hasFeatured) return false;
  const saved = (await Settings.findOne({ userId }).select('export.includeFeaturedInTitle').lean()) as { export?: { includeFeaturedInTitle?: boolean } } | null;
  return saved?.export?.includeFeaturedInTitle === true;
}

export async function compileLrc(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as Body;
  const { lines, includeTranslations = false, precision = 'hundredths', metadata = {}, includeFeaturedInTitle, lineEndings = 'lf', includeSecondary = false, wordPrecision, exportTranslationIndex = 0 } = body;
  const header = buildLrcExportMetadata(metadata, await resolveIncludeFeaturedInTitle(req, includeFeaturedInTitle, metadata));
  if (!header.ok) return reply.code(422).send({ error: header.message, code: header.code });
  const output = compileLRC(lines, includeTranslations, precision, header.metadata, lineEndings, includeSecondary, wordPrecision, exportTranslationIndex);
  return reply.send({ output, format: 'lrc' });
}

export async function compileSrt(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as Body;
  const { lines, duration = null, includeTranslations = false, lineEndings = 'lf', srtConfig = {}, includeSecondary = false, exportTranslationIndex = 0 } = body;
  const output = compileSRT(lines, duration, includeTranslations, lineEndings, srtConfig, includeSecondary, exportTranslationIndex);
  return reply.send({ output, format: 'srt' });
}

export async function inferEnd(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as Body;
  const { lines, duration = null, srtConfig = {} } = body;
  const startedAt = Date.now();
  const publicId = typeof (body as { publicId?: unknown }).publicId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test((body as { publicId: string }).publicId)
    ? (body as { publicId: string }).publicId
    : null;
  const actorId = await auditActorId(req);
  const base = () => ({
    jobType: 'infer_end_times' as const,
    userId: actorId,
    publicId,
    lineCount: Array.isArray(lines) ? lines.length : null,
    durationMs: Date.now() - startedAt,
    ip: req.ip,
    deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : null,
  });
  try {
    const result = inferEndTimes(lines, duration, srtConfig);
    await JobLog.create({ ...base(), status: 'succeeded' }).catch(() => {});
    return reply.send({ lines: result });
  } catch (error) {
    req.log.error({ err: error }, 'inferEndTimes failed');
    await JobLog.create({ ...base(), status: 'failed', error: (error as Error).message || 'unknown_error' }).catch(() => {});
    return reply.code(500).send({ error: 'infer_failed' });
  }
}
