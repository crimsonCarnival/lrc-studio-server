import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../db/user.model.js';
import { resetLapsedStreaks } from './streak-lapse.job.js';
import { getStreakView } from '../modules/badges/badge.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => { await User.deleteMany({}); });

// Fixed "now" so the UTC day boundaries in these cases never drift with the clock.
const NOW = new Date('2026-09-29T04:00:00.000Z');
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86400000);

let n = 0;
async function mkUser(streak: Record<string, unknown>) {
  n++;
  const res = await User.collection.insertOne({
    accountName: `u${n}`, email: `u${n}@x.test`, passwordHash: 'x',
    isDeleted: false, role: 'user', permissions: [], ban: { active: false },
    streak,
  });
  return res.insertedId.toString();
}
const streakOf = async (id: string) =>
  (await User.findById(id).select('streak').lean())?.streak as
    { current?: number; longest?: number } | undefined;

describe('resetLapsedStreaks', () => {
  it('leaves a streak active today untouched', async () => {
    const id = await mkUser({ current: 5, longest: 7, lastActiveDate: NOW });
    expect(await resetLapsedStreaks(NOW)).toBe(0);
    expect((await streakOf(id))?.current).toBe(5);
  });

  it('leaves a streak active yesterday untouched — it is still alive', async () => {
    const id = await mkUser({ current: 5, longest: 7, lastActiveDate: daysBefore(1) });
    expect(await resetLapsedStreaks(NOW)).toBe(0);
    expect((await streakOf(id))?.current).toBe(5);
  });

  it('zeroes a streak whose last activity was two days ago', async () => {
    const id = await mkUser({ current: 5, longest: 7, lastActiveDate: daysBefore(2) });
    expect(await resetLapsedStreaks(NOW)).toBe(1);
    expect((await streakOf(id))?.current).toBe(0);
  });

  it('preserves longest — it is the historical record', async () => {
    const id = await mkUser({ current: 5, longest: 7, lastActiveDate: daysBefore(9) });
    await resetLapsedStreaks(NOW);
    expect((await streakOf(id))?.longest).toBe(7);
  });

  it('handles a null or missing lastActiveDate', async () => {
    const a = await mkUser({ current: 3, longest: 3, lastActiveDate: null });
    const b = await mkUser({ current: 2, longest: 2 });
    expect(await resetLapsedStreaks(NOW)).toBe(2);
    expect((await streakOf(a))?.current).toBe(0);
    expect((await streakOf(b))?.current).toBe(0);
  });

  it('is idempotent — a second run changes nothing', async () => {
    await mkUser({ current: 5, longest: 5, lastActiveDate: daysBefore(4) });
    expect(await resetLapsedStreaks(NOW)).toBe(1);
    expect(await resetLapsedStreaks(NOW)).toBe(0);
  });

  it('agrees with getStreakView for every case', async () => {
    // The job and the read-side view must draw the alive/dead line in the same
    // place, or the DB and the UI disagree again — which is the bug this fixes.
    for (const days of [0, 1, 2, 5]) {
      await User.deleteMany({});
      const id = await mkUser({ current: 5, longest: 5, lastActiveDate: daysBefore(days) });
      await resetLapsedStreaks(NOW);
      const stored = (await streakOf(id))?.current ?? 0;
      const viewed = getStreakView({ current: 5, longest: 5, lastActiveDate: daysBefore(days) }, NOW).current;
      expect(stored).toBe(viewed);
    }
  });
});
