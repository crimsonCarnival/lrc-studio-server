import type { FastifyRequest, FastifyReply } from 'fastify';
import { getIO } from '../../socket/socket.manager.js';
import { startStampJob } from './asr.service.js';
import { getJob, cancelJob, getAudio } from './job.store.js';
import type { LineInput } from './align.service.js';

const ALLOWED_FORMATS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'webm', 'mp4'];
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type StampBody = { lines: LineInput[]; uploadId?: string; youtubeUrl?: string; fuzzyTolerance?: number };

export async function stampFromUpload(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { lines, uploadId, youtubeUrl, fuzzyTolerance } = request.body as StampBody;
  // JSON schema (oneOf) guarantees exactly one of uploadId / youtubeUrl is present.
  const result = await startStampJob({
    userId: request.userId as string,
    lines, fuzzyTolerance,
    audio: uploadId
      ? { kind: 'cloudinary', uploadId }
      : { kind: 'youtube', url: youtubeUrl as string },
  });
  if ('error' in result) return reply.code(result.status).send({ error: result.error });
  return reply.code(202).send({ jobId: result.jobId });
}

export async function stampFromFile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  if (!file) return reply.code(400).send({ error: 'asr_unsupported_audio' });
  const ext = file.filename?.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_FORMATS.includes(ext)) return reply.code(400).send({ error: 'asr_unsupported_audio' });

  // Field ordering matters: busboy resolves parts in stream order, so the client
  // MUST append the 'payload' field before 'file' or file.fields.payload is empty.
  let payload: { lines?: LineInput[]; fuzzyTolerance?: number } = {};
  const payloadField = file.fields?.payload;
  const raw = Array.isArray(payloadField) ? undefined : (payloadField as { value?: string } | undefined)?.value;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { /* handled below */ }
  if (!Array.isArray(payload.lines) || payload.lines.length === 0 || payload.lines.length > 2000) {
    return reply.code(400).send({ error: 'invalid_lines' });
  }
  // Mirror the JSON route's schema bounds (asr.schema.ts) — both paths must validate identically.
  for (const l of payload.lines) {
    if (!Number.isInteger(l?.index) || (l.index as number) < 0 || typeof l?.text !== 'string' || l.text.length > 1000) {
      return reply.code(400).send({ error: 'invalid_lines' });
    }
    if (l.wordTokens !== undefined) {
      if (!Array.isArray(l.wordTokens) || l.wordTokens.length > 500 ||
          l.wordTokens.some((w: unknown) => typeof w !== 'string' || (w as string).length > 200)) {
        return reply.code(400).send({ error: 'invalid_lines' });
      }
    }
  }
  if (payload.fuzzyTolerance !== undefined &&
      (typeof payload.fuzzyTolerance !== 'number' || payload.fuzzyTolerance < 0.5 || payload.fuzzyTolerance > 1)) {
    return reply.code(400).send({ error: 'invalid_fuzzy_tolerance' });
  }

  let data: Buffer;
  try {
    data = await file.toBuffer(); // multipart plugin enforces fileSize limit while buffering
  } catch {
    return reply.code(413).send({ error: 'asr_unsupported_audio' });
  }

  const result = await startStampJob({
    userId: request.userId as string,
    lines: payload.lines,
    fuzzyTolerance: payload.fuzzyTolerance,
    audio: { kind: 'buffer', data, format: ext },
  });
  if ('error' in result) return reply.code(result.status).send({ error: result.error });
  return reply.code(202).send({ jobId: result.jobId });
}

export async function getJobStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as { id: string };
  const job = getJob(id);
  if (!job || job.userId !== (request.userId as string)) return reply.code(404).send({ error: 'asr_job_not_found' });
  return reply.send({ jobId: job.id, phase: job.phase, result: job.result, errorCode: job.errorCode });
}

export async function cancelJobHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as { id: string };
  const userId = request.userId as string;
  const ok = cancelJob(id, userId);
  if (!ok) return reply.code(404).send({ error: 'asr_job_not_found' });
  // cancelJob only aborts + flips phase; the socket event must be emitted here,
  // otherwise the client (which drives its UI from asr:progress) never sees 'cancelled'.
  // The job IS cancelled at this point — never let a socket hiccup turn 204 into 500.
  try {
    getIO().to(`user:${userId}`).emit('asr:progress', { jobId: id, phase: 'cancelled' });
  } catch { /* socket not ready */ }
  return reply.code(204).send();
}

/**
 * Stream back the cached audio buffer from a completed YouTube ASR job.
 * Used by the client to render a waveform without re-downloading the audio.
 */
export async function getJobAudio(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = request.params as { id: string };
  const job = getJob(id);
  if (!job || job.userId !== (request.userId as string)) return reply.code(404).send({ error: 'asr_job_not_found' });
  const audio = getAudio(id);
  if (!audio) return reply.code(404).send({ error: 'asr_audio_not_available' });
  const mimeType = audio.format === 'webm' ? 'audio/webm' : 'audio/mp4';
  return reply
    .code(200)
    .header('Content-Type', mimeType)
    .header('Content-Length', audio.buffer.byteLength)
    // Not truly cacheable (job IDs are ephemeral), but tell the browser it's immutable
    // for the duration of the session so it doesn't re-fetch on waveform re-init.
    .header('Cache-Control', 'private, max-age=600, immutable')
    .send(audio.buffer);
}
