// yt-dlp subprocess wrapper. Two invocations per extraction:
//   1. `-J` metadata probe (no download) — rejects too-long/live/unavailable
//      videos and selects an audio-only format Groq accepts natively (m4a/webm).
//   2. capped download of that format to stdout.
// Never a shell; argv is fully server-constructed from a validated videoId.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AsrError } from './groq.client.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Groq free-tier upload cap; doubles as OOM guard
const MAX_PROBE_BYTES = 5 * 1024 * 1024;  // -J output for a single video is well under this
const MAX_DURATION_S = 20 * 60;
const EXTRACT_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 3;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// Mirrors the client-side YT_PATTERN (PlayerEngine.tsx) — keep in sync.
const YT_URL = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|watch\?.+&v=)|youtu\.be\/)([^&?/\s]{11})/;

let activeExtractions = 0;

export function extractVideoId(input: string): string | null {
  if (VIDEO_ID.test(input)) return input;
  const m = input.match(YT_URL);
  return m && VIDEO_ID.test(m[1]) ? m[1] : null;
}

function canonicalUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function mapStderr(stderr: string): AsrError {
  if (/sign in to confirm|confirm you.{0,3}re not a bot|HTTP Error 403/i.test(stderr)) {
    return new AsrError('asr_youtube_blocked', 'yt-dlp blocked');
  }
  if (/video unavailable|private video|has been removed|not available in your country|members-only|age.restricted|This live event/i.test(stderr)) {
    return new AsrError('asr_youtube_unavailable', 'yt-dlp unavailable');
  }
  return new AsrError('asr_network', 'yt-dlp failed');
}

type RunOpts = { signal: AbortSignal; maxBytes: number };

function runYtdlp(args: string[], { signal, maxBytes }: RunOpts): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.env.YTDLP_PATH || 'yt-dlp', args, { shell: false, windowsHide: true });
    } catch {
      reject(new AsrError('asr_ytdlp_not_configured', 'yt-dlp spawn failed'));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const killAndReject = (err: AsrError) => settle(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(err);
    });

    const timer = setTimeout(() => killAndReject(new AsrError('asr_timeout', 'yt-dlp timed out')), EXTRACT_TIMEOUT_MS);
    const onAbort = () => killAndReject(new AsrError('asr_cancelled'));

    // Register ALL child listeners BEFORE any path that can kill the child
    // (already-aborted signal below). Killing a child with no 'error' listener
    // lets a subsequent 'error' emission (ENOENT, kill racing spawn) become an
    // unhandled 'error' event and crash the process.
    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = binary not installed → server misconfiguration, not a user error.
      killAndReject(err.code === 'ENOENT'
        ? new AsrError('asr_ytdlp_not_configured', 'yt-dlp binary not found')
        : new AsrError('asr_network', 'yt-dlp process error'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        killAndReject(new AsrError('asr_unsupported_audio', 'extracted audio too large'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // stderr is only pattern-matched for error mapping; cap what we retain.
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (code === 0) settle(() => resolve(Buffer.concat(chunks)));
      else settle(() => reject(mapStderr(stderr)));
    });

    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type ProbeFormat = { format_id?: string; ext?: string; acodec?: string; vcodec?: string; abr?: number };
type Probe = { duration?: number; live_status?: string; is_live?: boolean; formats?: ProbeFormat[] };

function pickAudioFormat(formats: ProbeFormat[]): { formatId: string; format: 'm4a' | 'webm' } {
  const audioOnly = formats.filter((f) =>
    f.format_id && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  for (const ext of ['m4a', 'webm'] as const) {
    const candidates = audioOnly.filter((f) => f.ext === ext).sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));
    if (candidates[0]) return { formatId: candidates[0].format_id as string, format: ext };
  }
  throw new AsrError('asr_unsupported_audio', 'no m4a/webm audio-only format');
}

export async function extractYoutubeAudio(videoId: string, signal: AbortSignal): Promise<{ data: Buffer; format: 'm4a' | 'webm' }> {
  if (!VIDEO_ID.test(videoId)) throw new AsrError('asr_unsupported_audio', 'invalid videoId');
  if (activeExtractions >= MAX_CONCURRENT) {
    throw new AsrError('asr_rate_limited', 'too many concurrent extractions');
  }
  activeExtractions++;
  try {
    const url = canonicalUrl(videoId);

    const probeOut = await runYtdlp(['--extractor-args', 'youtube:player_client=android,web', '-J', '--no-playlist', url], { signal, maxBytes: MAX_PROBE_BYTES });
    let probe: Probe;
    try { probe = JSON.parse(probeOut.toString('utf8')) as Probe; }
    catch { throw new AsrError('asr_youtube_unavailable', 'unparseable probe'); }

    if (probe.is_live || (probe.live_status && probe.live_status !== 'not_live' && probe.live_status !== 'was_live')) {
      throw new AsrError('asr_youtube_unavailable', 'live stream');
    }
    if (!probe.duration || probe.duration > MAX_DURATION_S) {
      throw new AsrError('asr_youtube_too_long', `duration ${probe.duration ?? 'unknown'}s`);
    }
    const { formatId, format } = pickAudioFormat(probe.formats ?? []);

    const data = await runYtdlp(['--extractor-args', 'youtube:player_client=android,web', '-f', formatId, '--no-playlist', '-o', '-', url], { signal, maxBytes: MAX_AUDIO_BYTES });
    if (data.byteLength === 0) throw new AsrError('asr_youtube_unavailable', 'empty download');
    return { data, format };
  } finally {
    activeExtractions--;
  }
}
