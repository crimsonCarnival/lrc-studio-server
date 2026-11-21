import { describe, it, expect } from 'vitest';
import { deriveErrorCode } from '../error-code.js';
import { uploadResolvers } from './upload.resolvers.js';
import type { Context } from './context.js';

const signedOut = { userId: null } as Context;
const signedIn = { userId: '64b000000000000000000001' } as Context;

describe('updateMedia mutation guards', () => {
  it('signed-out caller is refused as unauthorized before any lookup', async () => {
    const run = uploadResolvers.Mutation.updateMedia(undefined, { id: 'x', input: { title: 'a' } }, signedOut);
    await expect(run).rejects.toThrow('Unauthorized');
  });

  it('a banned caller is reported as banned, not sent into a refresh loop', async () => {
    try {
      await uploadResolvers.Mutation.updateMedia(undefined, { id: 'x', input: { title: 'a' } }, signedOut);
    } catch (err) {
      expect(deriveErrorCode(err, { banned: true })).toBe('banned');
      return;
    }
    throw new Error('expected a rejection');
  });

  it('rejects an over-long title before touching the database', async () => {
    const run = uploadResolvers.Mutation.updateMedia(undefined, { id: 'x', input: { title: 'a'.repeat(501) } }, signedIn);
    await expect(run).rejects.toThrow('Title too long');
  });

  it('rejects an over-long file name before touching the database', async () => {
    const run = uploadResolvers.Mutation.updateMedia(undefined, { id: 'x', input: { fileName: 'a'.repeat(501) } }, signedIn);
    await expect(run).rejects.toThrow('File name too long');
  });
});
