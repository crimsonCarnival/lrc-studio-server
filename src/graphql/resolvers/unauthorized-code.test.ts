import { describe, it, expect } from 'vitest';
import { deriveErrorCode } from '../error-code.js';
import { wallResolvers } from './wall.resolvers.js';
import { reportResolvers } from './report.resolvers.js';
import type { Context } from './context.js';

// The client refreshes an expired session only on the exact code `unauthorized`
// (graphql.client.ts), and an explicit extensions.code is passed through verbatim,
// so a resolver that sets its own code must set it in that casing.

const signedOut = { userId: null } as Context;

async function codeOf(run: () => Promise<unknown>, opts?: { banned?: boolean }): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return deriveErrorCode(err, opts);
  }
  throw new Error('expected a rejection');
}

describe('signed-out caller on a resolver with its own requireUser', () => {
  it('wall mutation answers unauthorized', async () => {
    const code = await codeOf(() => wallResolvers.Mutation.addWallComment(undefined, { accountName: 'someone', body: 'hi' }, signedOut));
    expect(code).toBe('unauthorized');
  });

  it('report mutation answers unauthorized', async () => {
    const code = await codeOf(() => reportResolvers.Mutation.fileReport(undefined, { targetType: 'project', targetId: 'x', reason: 'spam' }, signedOut));
    expect(code).toBe('unauthorized');
  });

  it('a banned caller is told banned, not sent into a refresh loop', async () => {
    const code = await codeOf(() => reportResolvers.Query.myReports(undefined, {}, signedOut), { banned: true });
    expect(code).toBe('banned');
  });
});
