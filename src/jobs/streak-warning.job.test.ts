import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import User from '../db/user.model.js';
import UserPreferences from '../db/user-preferences.model.js';
import Notification from '../modules/notifications/notification.model.js';
import Project from '../modules/projects/project.model.js';
import { sendStreakWarnings } from './streak-warning.job.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), UserPreferences.deleteMany({}), Notification.deleteMany({}), Project.deleteMany({})]);
});

const NOW = new Date('2026-09-24T19:00:00Z');
const YESTERDAY = new Date('2026-09-23T10:00:00Z');

let n = 0;
async function mkUser(extra: Record<string, unknown> = {}) {
  n++;
  const res = await User.collection.insertOne({
    accountName: `u${n}`, email: `u${n}@x.test`, passwordHash: 'x', isDeleted: false,
    ban: { active: false }, shadowBan: { feed: false, search: false },
    streak: { current: 3, longest: 3, lastActiveDate: YESTERDAY },
    ...extra,
  });
  return res.insertedId;
}

describe('sendStreakWarnings', () => {
  it('does nothing before the configured UTC hour', async () => {
    await mkUser();
    expect(await sendStreakWarnings(new Date('2026-09-24T10:00:00Z'))).toBe(0);
  });

  it('warns eligible users once per UTC day and links the last project', async () => {
    const id = await mkUser();
    await Project.collection.insertMany([
      { userId: id, publicId: 'old', title: 'Old', updatedAt: new Date('2026-09-01T00:00:00Z') },
      { userId: id, publicId: 'new', title: 'New', updatedAt: new Date('2026-09-23T00:00:00Z') },
    ]);
    expect(await sendStreakWarnings(NOW)).toBe(1);
    expect(await sendStreakWarnings(NOW)).toBe(0);
    const notifs = await Notification.find({ userId: id }).lean();
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({ type: 'streak_warning', publicId: 'new', meta: { current: 3, day: '2026-09-24' } });
  });

  it('excludes ineligible users', async () => {
    await mkUser({ streak: { current: 1, lastActiveDate: YESTERDAY } });              // below min
    await mkUser({ streak: { current: 5, lastActiveDate: new Date('2026-09-24T01:00:00Z') } }); // active today
    await mkUser({ streak: { current: 5, lastActiveDate: new Date('2026-09-21T01:00:00Z') } }); // already broken
    await mkUser({ isDeleted: true });
    await mkUser({ ban: { active: true } });
    await mkUser({ shadowBan: { feed: true, search: false } });
    const optedOut = await mkUser();
    await UserPreferences.collection.insertOne({ userId: optedOut, notifications: { streak_warning: false } });
    expect(await sendStreakWarnings(NOW)).toBe(0);
  });

  it('treats a missing preference as enabled', async () => {
    const id = await mkUser();
    await UserPreferences.collection.insertOne({ userId: id, notifications: { follow: true } });
    expect(await sendStreakWarnings(NOW)).toBe(1);
  });
});
