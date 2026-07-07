import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { io, ioEmit } = vi.hoisted(() => {
  const ioEmit = vi.fn();
  const io = { to: vi.fn().mockReturnThis(), emit: ioEmit };
  return { io, ioEmit };
});

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => io,
}));

vi.mock('./groq.client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./groq.client.js')>();
  return {
    ...actual,
    transcribeAudio: vi.fn(),
    isAsrConfigured: vi.fn(() => true),
  };
});

vi.mock('./ytdlp.client.js', () => ({
  extractVideoId: vi.fn((input: string) => (/^[A-Za-z0-9_-]{11}$/.test(input) ? input : (input.match(/v=([A-Za-z0-9_-]{11})/)?.[1] ?? null))),
  extractYoutubeAudio: vi.fn(),
}));

vi.mock('../uploads/upload.model.js', () => ({
  default: { findById: vi.fn() },
}));

import { startStampJob } from './asr.service.js';
import { transcribeAudio, isAsrConfigured, AsrError } from './groq.client.js';
import { extractYoutubeAudio } from './ytdlp.client.js';
import Upload from '../uploads/upload.model.js';
import { getJob, cancelJob } from './job.store.js';

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

let uidCounter = 0;
function nextUserId(): string {
  uidCounter += 1;
  return `user-${uidCounter}`;
}

function mockUploadDoc(doc: { userId: string; source: string; uploadUrl?: string } | null) {
  const resolved = doc
    ? { userId: { toString: () => doc.userId }, source: doc.source, uploadUrl: doc.uploadUrl }
    : null;
  vi.mocked(Upload.findById).mockReturnValue({ lean: vi.fn().mockResolvedValue(resolved) } as never);
}

function smallAudioResponse(): Response {
  // Real Response with an explicit Content-Length (undici does not auto-derive one
  // for a manually constructed Response) and a genuine readable stream, exercising
  // the capped-stream-reader path.
  const body = new TextEncoder().encode('audiodata');
  return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAsrConfigured).mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startStampJob', () => {
  it('happy path: cloudinary audio runs through phases to completed with stamped result', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/song.mp3' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(smallAudioResponse()));
    vi.mocked(transcribeAudio).mockResolvedValue([
      { text: 'hello', start: 0, end: 1 },
      { text: 'world', start: 1, end: 2 },
    ]);

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello world' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });

    expect(outcome).toHaveProperty('jobId');
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('completed'));

    const job = getJob(jobId)!;
    expect(job.result).toEqual([
      { index: 0, timestamp: 0, endTime: 2, confidence: 1, status: 'matched', words: [{ time: 0, word: 'hello' }, { time: 1, word: 'world' }] },
    ]);
    expect(job.errorCode).toBeUndefined();

    // Phase-order assertion on emitted socket events.
    const emittedPhases = ioEmit.mock.calls.map(([, payload]) => (payload as { phase: string }).phase);
    expect(emittedPhases).toEqual(['fetching_audio', 'transcribing', 'aligning', 'completed']);
    expect(io.to).toHaveBeenCalledWith(`user:${userId}`);
    const finalPayload = ioEmit.mock.calls.at(-1)![1] as { jobId: string; phase: string; result?: unknown };
    expect(finalPayload).toMatchObject({ jobId, phase: 'completed' });
    expect(finalPayload.result).toEqual(job.result);
  });

  it('returns not_found when the upload does not exist', async () => {
    const userId = nextUserId();
    mockUploadDoc(null);

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'missing' },
    });

    expect(outcome).toEqual({ error: 'not_found', status: 404 });
  });

  it('returns not_found when the upload belongs to a different user', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId: 'someone-else', source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/x.mp3' });

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });

    expect(outcome).toEqual({ error: 'not_found', status: 404 });
  });

  it('returns asr_unsupported_audio for a youtube-source upload', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'youtube' });

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });

    expect(outcome).toEqual({ error: 'asr_unsupported_audio', status: 400 });
  });

  it('marks the job failed with the AsrError code when transcription throws', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/song.mp3' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(smallAudioResponse()));
    vi.mocked(transcribeAudio).mockRejectedValue(new AsrError('asr_timeout'));

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('failed'));

    const job = getJob(jobId)!;
    expect(job.errorCode).toBe('asr_timeout');
    expect(job.result).toBeUndefined();
    const finalPayload = ioEmit.mock.calls.at(-1)![1] as { errorCode?: string; result?: unknown };
    expect(finalPayload.errorCode).toBe('asr_timeout');
    expect(finalPayload.result).toBeUndefined();
  });

  it('cancelling mid-transcribe leaves the job cancelled with no result', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/song.mp3' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(smallAudioResponse()));
    vi.mocked(transcribeAudio).mockImplementation(
      (_data: Buffer, _format: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new AsrError('asr_cancelled')));
        })
    );

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('transcribing'));

    const cancelled = cancelJob(jobId, userId);
    expect(cancelled).toBe(true);

    // cancelJob flips the phase synchronously.
    expect(getJob(jobId)!.phase).toBe('cancelled');

    // Let the aborted runJob promise settle, then assert the service layer
    // emitted NO 'cancelled' progress event — the cancel endpoint owns that emit.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const emittedPhases = ioEmit.mock.calls.map(([, payload]) => (payload as { phase: string }).phase);
    expect(emittedPhases).toEqual(['fetching_audio', 'transcribing']);

    const job = getJob(jobId)!;
    expect(job.phase).toBe('cancelled');
    expect(job.result).toBeUndefined();
    expect(job.errorCode).toBeUndefined();
  });

  it('fails with asr_unsupported_audio and never fetches when uploadUrl is not a https res.cloudinary.com URL (SSRF guard)', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://evil.example.com/x.mp3' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('failed'));

    const job = getJob(jobId)!;
    expect(job.errorCode).toBe('asr_unsupported_audio');
    expect(job.result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('fails with asr_unsupported_audio when Content-Length exceeds the size limit, without reading the body', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/song.mp3' });
    const oversized = {
      ok: true,
      headers: new Headers({ 'content-length': String(MAX_AUDIO_BYTES + 1) }),
      body: null,
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(oversized));

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('failed'));

    const job = getJob(jobId)!;
    expect(job.errorCode).toBe('asr_unsupported_audio');
    expect(job.result).toBeUndefined();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('fails with asr_unsupported_audio when Content-Length is missing', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/song.mp3' });
    const noLength = { ok: true, headers: new Headers(), body: null } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(noLength));

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('failed'));

    const job = getJob(jobId)!;
    expect(job.errorCode).toBe('asr_unsupported_audio');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('fails with asr_unsupported_audio when actual stream bytes exceed the cap despite a lying Content-Length', async () => {
    const userId = nextUserId();
    mockUploadDoc({ userId, source: 'cloudinary', uploadUrl: 'https://res.cloudinary.com/demo/video/upload/song.mp3' });
    // Content-Length lies (well under the cap) but the real stream exceeds MAX_AUDIO_BYTES —
    // the streaming reader in fetchCloudinaryAudio must catch this independently of the header.
    const oversizedChunk = new Uint8Array(MAX_AUDIO_BYTES + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedChunk);
        controller.close();
      },
    });
    const lying = {
      ok: true,
      headers: new Headers({ 'content-length': '10' }),
      body: stream,
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(lying));

    const outcome = await startStampJob({
      userId,
      lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'cloudinary', uploadId: 'upload-1' },
    });
    const jobId = (outcome as { jobId: string }).jobId;

    await vi.waitFor(() => expect(getJob(jobId)!.phase).toBe('failed'));

    const job = getJob(jobId)!;
    expect(job.errorCode).toBe('asr_unsupported_audio');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});

describe('startStampJob — youtube source', () => {
  it('rejects an unparseable youtube URL with 400', async () => {
    const res = await startStampJob({
      userId: 'u1', lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'youtube', url: 'https://evil.com/nope' },
    });
    expect(res).toEqual({ error: 'asr_unsupported_audio', status: 400 });
  });

  it('runs extraction then transcription and completes', async () => {
    vi.mocked(extractYoutubeAudio).mockResolvedValueOnce({ data: Buffer.from('a'), format: 'm4a' });
    vi.mocked(transcribeAudio).mockResolvedValueOnce([
      { text: 'hello', start: 0, end: 1 },
    ]);
    const res = await startStampJob({
      userId: 'u2', lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    expect('jobId' in res).toBe(true);
    const jobId = (res as { jobId: string }).jobId;
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('completed'));
    expect(vi.mocked(extractYoutubeAudio)).toHaveBeenCalledWith('dQw4w9WgXcQ', expect.any(AbortSignal));
  });

  it('fails the job with the extraction error code', async () => {
    vi.mocked(extractYoutubeAudio).mockRejectedValueOnce(new AsrError('asr_youtube_blocked'));
    const res = await startStampJob({
      userId: 'u3', lines: [{ index: 0, text: 'hello' }],
      audio: { kind: 'youtube', url: 'dQw4w9WgXcQ' },
    });
    const jobId = (res as { jobId: string }).jobId;
    await vi.waitFor(() => expect(getJob(jobId)?.phase).toBe('failed'));
    expect(getJob(jobId)?.errorCode).toBe('asr_youtube_blocked');
  });
});
