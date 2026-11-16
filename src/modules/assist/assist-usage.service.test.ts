import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import AssistUsage from './assist-usage.model.js';
import { AssistError } from './groq-chat.client.js';
import { getHeavyUsage, runHeavy } from './assist-usage.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await AssistUsage.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await AssistUsage.deleteMany({});
  delete process.env.ASSIST_HEAVY_DAILY_CAP;
});
afterEach(() => {
  delete process.env.ASSIST_HEAVY_DAILY_CAP;
});

const now = new Date('2026-11-15T23:00:00Z');
const D1 = new Date('2026-11-15T00:00:00.000Z');
const D2 = new Date('2026-11-16T00:00:00.000Z');
const newUser = () => new mongoose.Types.ObjectId().toString();
const stored = async (u: string, day = D1) =>
  (await AssistUsage.findOne({ userId: u, day }).lean())?.heavy;
const ok = async () => 'ok';

describe('runHeavy', () => {
  it('allows 20 runs and refuses the 21st with assist_daily_cap and resetsAt at the next UTC midnight', async () => {
    const u = newUser();
    for (let i = 0; i < 20; i++) await runHeavy(u, ok, now);
    let called = false;
    const err = await runHeavy(u, async () => { called = true; return 1; }, now).catch((e) => e);
    expect(err).toBeInstanceOf(AssistError);
    expect(err.code).toBe('assist_daily_cap');
    expect(err.resetsAt.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(called).toBe(false);
  });

  it('25 concurrent runs: exactly 20 succeed', async () => {
    const u = newUser();
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => runHeavy(u, ok, now)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    expect(await stored(u)).toBe(20);
  });

  it('assist_unavailable (nothing billed) refunds the run', async () => {
    const u = newUser();
    await expect(runHeavy(u, async () => { throw new AssistError('assist_unavailable'); }, now)).rejects.toMatchObject({ code: 'assist_unavailable' });
    expect(await stored(u)).toBe(0);
  });

  it('assist_upstream is not refunded', async () => {
    const u = newUser();
    await expect(runHeavy(u, async () => { throw new AssistError('assist_upstream'); }, now)).rejects.toMatchObject({ code: 'assist_upstream' });
    expect(await stored(u)).toBe(1);
  });

  it('a plain Error is rethrown and not refunded', async () => {
    const u = newUser();
    await expect(runHeavy(u, async () => { throw new TypeError('boom'); }, now)).rejects.toBeInstanceOf(TypeError);
    expect(await stored(u)).toBe(1);
  });

  it('refund after midnight credits the charged day (clock moves mid-run)', async () => {
    const u = newUser();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(now);
      await expect(
        runHeavy(u, async () => {
          vi.setSystemTime(new Date('2026-11-16T00:00:05Z'));
          throw new AssistError('assist_unavailable');
        }),
      ).rejects.toBeInstanceOf(AssistError);
    } finally {
      vi.useRealTimers();
    }
    expect(await stored(u, D1)).toBe(0);
    expect(await stored(u, D2)).toBeUndefined();
  });

  it('refund never goes below 0', async () => {
    const u = newUser();
    await expect(
      runHeavy(u, async () => {
        await AssistUsage.updateOne({ userId: u, day: D1 }, { $set: { heavy: 0 } });
        throw new AssistError('assist_unavailable');
      }, now),
    ).rejects.toBeInstanceOf(AssistError);
    expect(await stored(u)).toBe(0);
  });

  it('a first-run E11000 race is retried once and charged once', async () => {
    const u = newUser();
    const spy = vi.spyOn(AssistUsage, 'findOneAndUpdate').mockImplementationOnce((() => {
      throw Object.assign(new Error('dup'), { code: 11000 });
    }) as never);
    const { usage } = await runHeavy(u, ok, now);
    spy.mockRestore();
    expect(usage.used).toBe(1);
    expect(await stored(u)).toBe(1);
  });

  it('a failing refund is logged and the original error is rethrown', async () => {
    const u = newUser();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const upd = vi.spyOn(AssistUsage, 'updateOne').mockRejectedValueOnce(new Error('db down') as never);
    await expect(runHeavy(u, async () => { throw new AssistError('assist_unavailable'); }, now)).rejects.toMatchObject({ code: 'assist_unavailable' });
    expect(log).toHaveBeenCalled();
    upd.mockRestore();
    log.mockRestore();
  });

  it('a new UTC day starts from 0', async () => {
    const u = newUser();
    for (let i = 0; i < 20; i++) await runHeavy(u, ok, now);
    const next = new Date('2026-11-16T00:00:01Z');
    const { usage } = await runHeavy(u, ok, next);
    expect(usage.used).toBe(1);
    expect(usage.remaining).toBe(19);
  });

  it('ASSIST_HEAVY_DAILY_CAP=3 caps at 3; "abc" and "0" fall back to 20', async () => {
    process.env.ASSIST_HEAVY_DAILY_CAP = '3';
    const u = newUser();
    for (let i = 0; i < 3; i++) await runHeavy(u, ok, now);
    await expect(runHeavy(u, ok, now)).rejects.toMatchObject({ code: 'assist_daily_cap' });
    for (const bad of ['abc', '0']) {
      process.env.ASSIST_HEAVY_DAILY_CAP = bad;
      expect((await getHeavyUsage(newUser(), now)).cap).toBe(20);
    }
  });
});

describe('getHeavyUsage', () => {
  it('reports used/remaining without incrementing', async () => {
    const u = newUser();
    await runHeavy(u, ok, now);
    await runHeavy(u, ok, now);
    const a = await getHeavyUsage(u, now);
    expect(a).toEqual({ used: 2, cap: 20, remaining: 18, resetsAt: D2 });
    await getHeavyUsage(u, now);
    expect(await stored(u)).toBe(2);
    expect((await getHeavyUsage(newUser(), now)).used).toBe(0);
  });
});

describe('AssistUsage indexes', () => {
  it('unique userId+day and a 172800 s TTL on day', async () => {
    await AssistUsage.syncIndexes();
    const idx = await AssistUsage.collection.listIndexes().toArray();
    const uniq = idx.find((i) => i.key.userId === 1 && i.key.day === 1);
    expect(uniq?.unique).toBe(true);
    const ttl = idx.find((i) => i.key.day === 1 && !i.key.userId);
    expect(ttl?.expireAfterSeconds).toBe(172800);
  });
});
