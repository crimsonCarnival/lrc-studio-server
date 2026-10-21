import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import OneTimeToken from './ott.model.js';
import { createOtt, consumeOtt } from './ott.service.js';

// This replaced a process-local Map specifically because mint and consume
// can land on different instances; a plain Mongo round-trip doesn't exercise
// that, but it does cover the properties that actually matter here:
// single-use atomicity (findOneAndDelete, not a separate read-then-delete)
// and TTL expiry, which a Map-based implementation got "for free" (per-process
// memory) and this one has to get from the collection's own index.

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await OneTimeToken.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await OneTimeToken.deleteMany({});
});

describe('OTT service', () => {
  it('round-trips the token pair exactly', async () => {
    const id = await createOtt({ accessToken: 'a', refreshToken: 'r' });
    const result = await consumeOtt(id);
    expect(result).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('is single-use: a second consume of the same id returns null', async () => {
    const id = await createOtt({ accessToken: 'a', refreshToken: 'r' });
    await consumeOtt(id);
    expect(await consumeOtt(id)).toBeNull();
  });

  it('two concurrent consumes of the same id: exactly one succeeds', async () => {
    const id = await createOtt({ accessToken: 'a', refreshToken: 'r' });
    const [first, second] = await Promise.all([consumeOtt(id), consumeOtt(id)]);
    const results = [first, second];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('an unknown id returns null', async () => {
    expect(await consumeOtt('does-not-exist')).toBeNull();
  });

  it('an expired entry is rejected even if the TTL index has not swept it yet', async () => {
    // Insert directly with an already-past expiresAt — the TTL background
    // task runs on its own schedule, so a real test can't wait for it;
    // consumeOtt's own expiresAt filter is what must reject this, not the
    // collection's eventual cleanup.
    await OneTimeToken.create({
      _id: 'manually-expired',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await consumeOtt('manually-expired')).toBeNull();
  });
});
