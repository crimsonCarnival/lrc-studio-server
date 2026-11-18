export class CappedBodyError extends Error {
  constructor(public readonly reason: 'empty' | 'too_large') {
    super(reason === 'empty' ? 'empty body' : 'body too large');
    this.name = 'CappedBodyError';
  }
}

/** Reads a response body, enforcing the byte cap on the actual stream (Content-Length can be missing or lie). */
export async function readCappedBody(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) throw new CappedBodyError('empty');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CappedBodyError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
