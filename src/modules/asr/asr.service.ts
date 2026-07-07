import { getIO } from '../../socket/socket.manager.js';
import Upload from '../uploads/upload.model.js';
import { transcribeAudio, AsrError, isAsrConfigured } from './groq.client.js';
import { extractVideoId, extractYoutubeAudio } from './ytdlp.client.js';
import { stampLines } from './align.service.js';
import type { LineInput } from './align.service.js';
import { createJob, setPhase, completeJob, failJob, getJob, setAudio } from './job.store.js';
import type { AsrJobPhase } from './job.store.js';

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

type AudioSource =
  | { kind: 'cloudinary'; uploadId: string }
  | { kind: 'buffer'; data: Buffer; format: string }
  | { kind: 'youtube'; url: string };

// Internal to runJob: cloudinary carries the URL already validated in
// startStampJob (TOCTOU); youtube carries the validated 11-char videoId.
type ResolvedAudio =
  | { kind: 'cloudinary'; url: string }
  | { kind: 'buffer'; data: Buffer; format: string }
  | { kind: 'youtube'; videoId: string };

type StartParams = { userId: string; lines: LineInput[]; fuzzyTolerance?: number; audio: AudioSource };

function emitProgress(userId: string, jobId: string): void {
  const job = getJob(jobId);
  if (!job) return;
  // Job state is authoritative (poll via GET /asr/jobs/:id) — a socket hiccup
  // must never crash the background job. Same defensive pattern as notifications.
  try {
    getIO().to(`user:${userId}`).emit('asr:progress', {
      jobId,
      phase: job.phase,
      ...(job.result ? { result: job.result } : {}),
      ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    });
  } catch { /* socket not ready */ }
}

function transition(userId: string, jobId: string, phase: AsrJobPhase): void {
  setPhase(jobId, phase);
  emitProgress(userId, jobId);
}

async function fetchCloudinaryAudio(url: string, signal: AbortSignal): Promise<{ data: Buffer; format: string }> {
  // SSRF guard: uploadUrl is user-influenced data; only fetch the Cloudinary CDN over https.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AsrError('asr_unsupported_audio', 'invalid audio URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') {
    throw new AsrError('asr_unsupported_audio', 'audio URL host not allowed');
  }
  // redirect: 'error' — never silently follow a redirect off the validated cloudinary host.
  const res = await fetch(url, { signal, redirect: 'error' });
  if (!res.ok) throw new AsrError('asr_unsupported_audio', `audio fetch HTTP ${res.status}`);
  const contentLength = res.headers.get('content-length');
  if (!contentLength || Number(contentLength) > MAX_AUDIO_BYTES) {
    throw new AsrError('asr_unsupported_audio', 'audio too large');
  }
  // Belt-and-braces vs a lying/missing Content-Length: cap the actual bytes read too.
  const buf = await readCappedBody(res, MAX_AUDIO_BYTES);
  const ext = parsed.pathname.split('.').pop()?.toLowerCase() ?? 'mp3';
  return { data: buf, format: ext };
}

async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) throw new AsrError('asr_unsupported_audio', 'empty audio body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AsrError('asr_unsupported_audio', 'audio too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function runJob(userId: string, jobId: string, lines: LineInput[], audio: ResolvedAudio, fuzzyTolerance?: number): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;
  const { signal } = job.abort;
  try {
    let data: Buffer, format: string;
    if (audio.kind === 'cloudinary') {
      transition(userId, jobId, 'fetching_audio');
      const fetched = await fetchCloudinaryAudio(audio.url, signal);
      data = fetched.data; format = fetched.format;
    } else if (audio.kind === 'youtube') {
      transition(userId, jobId, 'extracting_audio');
      const extracted = await extractYoutubeAudio(audio.videoId, signal);
      data = extracted.data; format = extracted.format;
      // Cache the audio buffer so the client can fetch it for waveform display.
      setAudio(jobId, data, format);
    } else {
      data = audio.data; format = audio.format;
    }
    if (signal.aborted) return; // cancel endpoint already flipped phase and emitted 'cancelled'

    transition(userId, jobId, 'transcribing');
    const words = await transcribeAudio(data, format, signal);
    if (signal.aborted) return;

    transition(userId, jobId, 'aligning');
    const result = stampLines(lines, words, { fuzzyTolerance });

    completeJob(jobId, result);
    emitProgress(userId, jobId);
  } catch (err) {
    // cancel endpoint already flipped phase and emitted 'cancelled'
    if (signal.aborted) return;
    const code = err instanceof AsrError ? err.code : 'asr_network';
    failJob(jobId, code);
    emitProgress(userId, jobId);
  }
}

export async function startStampJob(params: StartParams): Promise<{ jobId: string } | { error: string; status: number }> {
  if (!isAsrConfigured()) return { error: 'asr_not_configured', status: 503 };
  const { userId, lines, audio, fuzzyTolerance } = params;

  let resolved: ResolvedAudio;
  if (audio.kind === 'cloudinary') {
    const upload = await Upload.findById(audio.uploadId).lean() as { userId?: { toString(): string }; source?: string; uploadUrl?: string } | null;
    if (!upload || upload.userId?.toString() !== userId) return { error: 'not_found', status: 404 };
    if (upload.source !== 'cloudinary' || !upload.uploadUrl) return { error: 'asr_unsupported_audio', status: 400 };
    resolved = { kind: 'cloudinary', url: upload.uploadUrl };
  } else if (audio.kind === 'youtube') {
    const videoId = extractVideoId(audio.url);
    if (!videoId) return { error: 'asr_unsupported_audio', status: 400 };
    resolved = { kind: 'youtube', videoId };
  } else {
    if (audio.data.byteLength > MAX_AUDIO_BYTES) return { error: 'asr_unsupported_audio', status: 400 };
    resolved = audio;
  }

  let job;
  try {
    job = createJob(userId);
  } catch (err) {
    if (err instanceof AsrError && err.code === 'asr_job_active') return { error: 'asr_job_active', status: 409 };
    throw err;
  }
  // Fire and forget — result travels over Socket.IO and GET /asr/jobs/:id.
  void runJob(userId, job.id, lines, resolved, fuzzyTolerance);
  return { jobId: job.id };
}
