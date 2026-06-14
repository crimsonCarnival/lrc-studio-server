import type { FastifyRequest, FastifyReply } from 'fastify';
import type { LineEntry } from '../../types/index.js';

import {
  parseLrcSrtFile,
  compileLRC,
  inferEndTimes,
} from '../../utils/lrc.js';

import { compileSRT } from '../../utils/srt.js';

import {
  applyMark,
  applyBulkShift,
  applyGlobalOffset,
  clearAllTimestamps,
  clearLineTimestamp,
  detectDuplicateTimestamps,
} from './lyrics.service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

export async function parse(req: FastifyRequest, reply: FastifyReply) {
  const { content, filename, options } = req.body as Body;

  if (!content || typeof content !== 'string') {
    return reply.code(400).send({ error: 'Lyrics content is required' });
  }

  if (content.length > 5 * 1024 * 1024) {
    return reply.code(413).send({ error: 'Lyrics content too large (max 5MB)' });
  }

  const normalizedName = ((filename as string) || 'lyrics.lrc').toLowerCase();
  if (!normalizedName.endsWith('.lrc') && !normalizedName.endsWith('.srt') && !normalizedName.endsWith('.txt')) {
    return reply.code(400).send({ error: 'Unsupported lyrics format' });
  }

  const lines = parseLrcSrtFile(content, filename as string, options && typeof options === 'object' ? options : {});
  return reply.send({
    lines,
    detectedFormat: filename?.toLowerCase().endsWith('.srt') ? 'srt' : 'lrc',
    count: lines.length,
  });
}

export async function compileLrc(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as Body;
  const { lines, includeTranslations = false, precision = 'hundredths', metadata = {}, lineEndings = 'lf', includeSecondary = false, wordPrecision, exportTranslationIndex = 0 } = body;
  const output = compileLRC(lines, includeTranslations, precision, metadata, lineEndings, includeSecondary, wordPrecision, exportTranslationIndex);
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
  const result = inferEndTimes(lines, duration, srtConfig);
  return reply.send({ lines: result });
}

export async function mark(req: FastifyRequest, reply: FastifyReply) {
  const body = req.body as Body;
  const { lines, activeLineIndex, time, editorMode, activeWordIndex = 0, stampTarget = 'main', awaitingEndMark = null, focusedTimestamp = null, settings } = body;
  const result = applyMark({ lines, activeLineIndex, time, editorMode, activeWordIndex, stampTarget, awaitingEndMark, focusedTimestamp, settings });
  return reply.send(result);
}

export async function bulkShift(req: FastifyRequest, reply: FastifyReply) {
  const { lines, selectedIndices, delta } = req.body as Body;
  const result = applyBulkShift(lines, selectedIndices, delta);
  return reply.send({ lines: result });
}

export async function globalOffset(req: FastifyRequest, reply: FastifyReply) {
  const { lines, delta } = req.body as Body;
  const result = applyGlobalOffset(lines, delta);
  return reply.send({ lines: result });
}

export async function clearAll(req: FastifyRequest, reply: FastifyReply) {
  const { lines, isSrt = false, isWords = false } = req.body as Body;
  const result = clearAllTimestamps(lines, isSrt, isWords);
  return reply.send({ lines: result });
}

export async function clearLine(req: FastifyRequest, reply: FastifyReply) {
  const { lines, index, isSrt = false, isWords = false } = req.body as Body;
  const result = clearLineTimestamp(lines, index, isSrt, isWords);
  return reply.send({ lines: result });
}

export async function detectDuplicates(req: FastifyRequest, reply: FastifyReply) {
  const { lines, threshold = 0.05 } = req.body as Body;
  const indices = detectDuplicateTimestamps(lines, threshold);
  return reply.send({ overlappingIndices: indices });
}