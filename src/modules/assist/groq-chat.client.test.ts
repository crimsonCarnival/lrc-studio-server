import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatJson, isAssistConfigured, assistModel, AssistError } from './groq-chat.client.js';

const URL_ = 'https://api.groq.com/openai/v1/chat/completions';
const messages = [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'u' }];
const spec = { name: 'thing', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } };
const guard = (v: unknown): v is { ok: boolean } => typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';

function ok(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content, reasoning: 'secret thoughts' } }] }), { status: 200 });
}
async function failure(p: Promise<unknown>): Promise<AssistError> {
  try { await p; } catch (e) { return e as AssistError; }
  throw new Error('expected rejection');
}

beforeEach(() => { process.env.GROQ_API_KEY = 'test-key'; delete process.env.ASSIST_MODEL; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('chatJson', () => {
  it('sends the strict json_schema body', async () => {
    const f = vi.fn().mockResolvedValue(ok('{"ok":true}'));
    vi.stubGlobal('fetch', f);
    await chatJson('m', messages, spec, { validate: guard });
    expect(f.mock.calls[0][0]).toBe(URL_);
    const init = f.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({
      model: 'm', messages,
      response_format: { type: 'json_schema', json_schema: { name: 'thing', strict: true, schema: spec.schema } },
      reasoning_effort: 'low', include_reasoning: false, stream: false,
    });
  });
  it('returns the validated content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('{"ok":true}')));
    await expect(chatJson('m', messages, spec, { validate: guard })).resolves.toEqual({ ok: true });
  });
  it('assist_unavailable without a key and never calls fetch', async () => {
    delete process.env.GROQ_API_KEY;
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(isAssistConfigured()).toBe(false);
    expect((await failure(chatJson('m', messages, spec, { validate: guard }))).code).toBe('assist_unavailable');
    expect(f).not.toHaveBeenCalled();
  });
  it.each([401, 403])('%i maps to assist_unavailable', async status => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', f);
    expect((await failure(chatJson('m', messages, spec, { validate: guard }))).code).toBe('assist_unavailable');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500, 400])('%i maps to assist_upstream', async status => {
    const f = vi.fn().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', f);
    expect((await failure(chatJson('m', messages, spec, { validate: guard }))).code).toBe('assist_upstream');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a TimeoutError or network failure maps to assist_upstream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    expect((await failure(chatJson('m', messages, spec, { validate: guard }))).code).toBe('assist_upstream');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect((await failure(chatJson('m', messages, spec, { validate: guard }))).code).toBe('assist_upstream');
  });
  it('non-JSON content, a missing choices array, and a guard returning false all map to assist_upstream', async () => {
    for (const res of [ok('not json'), new Response('{}', { status: 200 }), ok('{"ok":"x"}')]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
      expect((await failure(chatJson('m', messages, spec, { validate: guard }))).code).toBe('assist_upstream');
    }
  });
  it('upstream error text never reaches the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"secret upstream detail"}}', { status: 500 })));
    const err = await failure(chatJson('m', messages, spec, { validate: guard }));
    expect(err.message).toBe('assist_upstream');
    expect(String(err)).not.toContain('secret');
  });
});

describe('assistModel', () => {
  it('defaults and honours ASSIST_MODEL', () => {
    expect(assistModel()).toBe('openai/gpt-oss-20b');
    process.env.ASSIST_MODEL = 'x/y';
    expect(assistModel()).toBe('x/y');
  });
});
