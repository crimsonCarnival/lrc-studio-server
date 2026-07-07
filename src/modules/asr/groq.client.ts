// Groq Whisper transcription client. Live-verified 2026-07-05: verbose_json +
// timestamp_granularities[]=word returns `words: [{ word, start, end }]` in seconds.
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

export type AsrWord = { text: string; start: number; end: number };

export class AsrError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export function isAsrConfigured(): boolean {
  return !!process.env.GROQ_API_KEY;
}

// Rebuilt per attempt — a FormData body is consumed by fetch and cannot be reused.
function buildForm(audio: Buffer, format: string): FormData {
  const form = new FormData();
  // Copy into a plain-ArrayBuffer-backed view: Buffer's ArrayBufferLike backing
  // is not assignable to BlobPart under @types/node 25.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append('file', new Blob([bytes]), `audio.${format}`);
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  return form;
}

function parseWords(json: unknown): AsrWord[] {
  const words = (json as { words?: unknown } | null | undefined)?.words;
  if (!Array.isArray(words)) throw new AsrError('asr_malformed_response');
  return words.map((w: { word: unknown; start: unknown; end: unknown }) => ({
    text: String(w.word),
    start: Number(w.start),
    end: Number(w.end),
  }));
}

export async function transcribeAudio(audio: Buffer, format: string, signal: AbortSignal): Promise<AsrWord[]> {
  if (!isAsrConfigured()) throw new AsrError('asr_invalid_key', 'GROQ_API_KEY not set');

  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await backoff(attempt, signal);
    let res: Response;
    try {
      res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: buildForm(audio, format),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (signal.aborted) throw new AsrError('asr_cancelled');
      if ((err as Error).name === 'TimeoutError') throw new AsrError('asr_timeout');
      lastStatus = 0;
      continue; // network error → retry
    }
    if (res.status === 401 || res.status === 403) throw new AsrError('asr_invalid_key');
    if (res.status === 413) throw new AsrError('asr_unsupported_audio', 'audio exceeds provider size limit');
    if (res.status === 429 || res.status >= 500) { lastStatus = res.status; continue; }
    if (res.status === 400) throw new AsrError('asr_unsupported_audio', 'HTTP 400');
    if (!res.ok) throw new AsrError('asr_malformed_response', `HTTP ${res.status}`);
    const json = await res.json().catch(() => { throw new AsrError('asr_malformed_response'); });
    const words = parseWords(json);
    if (words.length === 0) throw new AsrError('asr_empty_transcript');
    return words;
  }
  throw new AsrError(lastStatus === 429 ? 'asr_rate_limited' : 'asr_network');
}

function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const ms = 1000 * 2 ** (attempt - 1);
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new AsrError('asr_cancelled')); }, { once: true });
  });
}
