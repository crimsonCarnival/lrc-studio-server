import { describe, expect, it } from 'vitest';
import { CappedBodyError, readCappedBody } from './read-capped-body.js';

const streamOf = (...chunks: Uint8Array[]): Response =>
  new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }));

describe('readCappedBody', () => {
  it('returns all bytes under the cap', async () => {
    const buf = await readCappedBody(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 10);
    expect([...buf]).toEqual([1, 2, 3]);
  });
  it('throws too_large past the cap even without Content-Length', async () => {
    const err = await readCappedBody(streamOf(new Uint8Array(6), new Uint8Array(6)), 10).catch((e) => e);
    expect(err).toBeInstanceOf(CappedBodyError);
    expect(err.reason).toBe('too_large');
  });
  it('throws empty on a null body', async () => {
    const err = await readCappedBody(new Response(null), 10).catch((e) => e);
    expect(err).toBeInstanceOf(CappedBodyError);
    expect(err.reason).toBe('empty');
  });
});
