import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribeAudio } from './groq.client.js';

// Groq verbose_json fixture (live-verified): { text, words: [{ word, start, end }] }.
function buildProviderResponse(words: Array<{ text: string; start: number; end: number }>) {
  return { text: 'x', words: words.map(w => ({ word: w.text, start: w.start, end: w.end })) };
}

function okResponse(words: Array<{ text: string; start: number; end: number }>) {
  return new Response(JSON.stringify(buildProviderResponse(words)), { status: 200 });
}

beforeEach(() => { process.env.GROQ_API_KEY = 'test-key'; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('transcribeAudio', () => {
  it('returns normalized AsrWord[] from a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([{ text: 'hello', start: 0.5, end: 0.9 }])));
    const words = await transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal);
    expect(words).toEqual([{ text: 'hello', start: 0.5, end: 0.9 }]);
  });
  it('sends multipart form with model and word timestamp granularity', async () => {
    const f = vi.fn().mockResolvedValue(okResponse([{ text: 'a', start: 0, end: 1 }]));
    vi.stubGlobal('fetch', f);
    await transcribeAudio(Buffer.from('x'), 'wav', new AbortController().signal);
    const body = f.mock.calls[0][1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('model')).toBe('whisper-large-v3');
    expect(body.get('response_format')).toBe('verbose_json');
    expect(body.get('timestamp_granularities[]')).toBe('word');
    expect((body.get('file') as File).name).toBe('audio.wav');
  });
  it('throws asr_invalid_key on 401 without retrying', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', f);
    await expect(transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal))
      .rejects.toMatchObject({ code: 'asr_invalid_key' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('throws asr_unsupported_audio on 413 without retrying', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 413 }));
    vi.stubGlobal('fetch', f);
    await expect(transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal))
      .rejects.toMatchObject({ code: 'asr_unsupported_audio' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('throws asr_unsupported_audio on 400 without retrying', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', f);
    await expect(transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal))
      .rejects.toMatchObject({ code: 'asr_unsupported_audio' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('retries twice on 5xx then throws asr_network', async () => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status: 502 }));
    vi.stubGlobal('fetch', f);
    await expect(transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal))
      .rejects.toMatchObject({ code: 'asr_network' });
    expect(f).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
  it('throws asr_rate_limited on 429 after retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    await expect(transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal))
      .rejects.toMatchObject({ code: 'asr_rate_limited' });
  });
  it('throws asr_empty_transcript when no words returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));
    await expect(transcribeAudio(Buffer.from('x'), 'mp3', new AbortController().signal))
      .rejects.toMatchObject({ code: 'asr_empty_transcript' });
  });
  it('throws asr_cancelled when the signal aborts', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_u, opts: RequestInit) =>
      new Promise((_res, rej) => opts.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))))));
    const p = transcribeAudio(Buffer.from('x'), 'mp3', ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'asr_cancelled' });
  });
});
