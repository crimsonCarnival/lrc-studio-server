/**
 * A user's country is what they chose in settings — never derived from their IP — and
 * others see it only per countryVisibility.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../../modules/notifications/notifications.service.js', () => ({
  createOnce: async () => undefined,
  notifyUnban: async () => undefined,
  notifyRoleChanged: async () => undefined,
  notifyXpChanged: async () => undefined,
  upsertSocial: async () => undefined,
  upsertFollow: async () => undefined,
}));
vi.mock('../../modules/email/email.service.js', () => ({ sendBanEmail: async () => undefined }));
vi.mock('../../modules/email-verification/email-verification.service.js', () => ({
  sendVerification: async () => undefined,
  resendVerification: async () => undefined,
}));
vi.mock('../../modules/badges/badge.service.js', () => ({
  triggerBadgeCheck: async () => undefined,
  updateStreak: async () => undefined,
  updateShowcase: async () => undefined,
  getBadgeRarity: async () => ({ rarity: 'common', holderCount: 1 }),
  getShowcaseSlots: () => 0,
  getStreakView: () => ({ current: 0, longest: 0 }),
  listBadgeDefsWithHolders: async () => [],
  listPublicBadgeDefs: async () => [],
  recomputeSyncStats: async () => undefined,
  scheduleSyncStatsRefresh: () => undefined,
}));
vi.mock('../../modules/activity/activity.service.js', () => ({
  writeActivity: async () => undefined,
  getPublicActivityHeatmap: async () => [],
  recordHeatmapEvent: async () => undefined,
}));

import User from '../../modules/users/user.model.js';
import UserPreferences from '../../modules/user-preferences/user-preferences.model.js';
import type { IUser } from '../../modules/users/user.model.js';
import { userResolvers } from './user.resolvers.js';
import type { Context } from './context.js';

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
  await Promise.all([User.deleteMany({}), UserPreferences.deleteMany({})]);
});

let n = 0;
async function mkUser(permissions: string[] = []): Promise<IUser> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `c${n}`, email: `c${n}@x.test`, passwordHash: 'x', role: 'user', permissions,
    ban: { active: false }, lastIp: '8.8.8.8',
  });
  return (await User.findById(res.insertedId).lean<IUser>())!;
}

const ctx = (userId: string | null) => ({ userId }) as unknown as Context;
const idOf = (u: IUser) => (u._id as mongoose.Types.ObjectId).toString();
const setPrefs = (u: IUser, input: Record<string, unknown>) =>
  userResolvers.Mutation.updatePreferences({}, { input }, ctx(idOf(u)));
const countryAs = (u: IUser, viewer: string | null) => userResolvers.User.country(u, {}, ctx(viewer));

describe('User.country', () => {
  it('is null until the user picks one, whatever their IP', async () => {
    const u = await mkUser();
    expect(await countryAs(u, idOf(u))).toBeNull();
  });

  it('shows the chosen country to its owner and staff, and to others per visibility', async () => {
    const u = await mkUser(), other = await mkUser(), staff = await mkUser(['users.view']);
    await setPrefs(u, { country: 'AR' });
    expect(await countryAs(u, idOf(u))).toBe('AR');
    expect(await countryAs(u, idOf(staff))).toBe('AR');
    expect(await countryAs(u, idOf(other))).toBeNull(); // default visibility is nobody

    await setPrefs(u, { countryVisibility: 'everyone' });
    expect(await countryAs(u, idOf(other))).toBe('AR');
    expect(await countryAs(u, null)).toBe('AR');
  });

  it('can be cleared', async () => {
    const u = await mkUser();
    await setPrefs(u, { country: 'AR' });
    await setPrefs(u, { country: null });
    expect(await countryAs(u, idOf(u))).toBeNull();
  });

  it('rejects anything that is not an ISO 3166-1 alpha-2 code', async () => {
    const u = await mkUser();
    for (const bad of ['XX', 'ar', 'ARG', 'LOCAL', '']) {
      await expect(setPrefs(u, { country: bad })).rejects.toThrow('Invalid country value');
    }
  });
});
