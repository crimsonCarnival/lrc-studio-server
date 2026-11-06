/**
 * Deploy-skew contract for the removed defaultProjectPrivacy setting: old clients
 * still send it and old documents still store it. Neither may error or take effect.
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
vi.mock('../../modules/projects/projects.controller.js', () => ({
  emitProjectUpdated: () => undefined,
}));
vi.mock('../../modules/projects/project-view.service.js', () => ({
  registerProjectView: async () => undefined,
}));
vi.mock('../../modules/users/music-library.service.js', () => ({
  upsertMusicLibraryEntry: async () => undefined,
}));

import { userResolvers } from './user.resolvers.js';
import User from '../../modules/users/user.model.js';
import UserPreferences from '../../modules/user-preferences/user-preferences.model.js';
import { getPreferences, invalidatePreferences } from '../../modules/user-preferences/user-preferences.service.js';

type Resolver = (root: unknown, args: Record<string, unknown>, context: unknown) => Promise<unknown>;
const updatePreferences = (userResolvers.Mutation as unknown as Record<string, Resolver>).updatePreferences;

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), UserPreferences.deleteMany({})]);
});

async function mkUser(): Promise<string> {
  const { insertedId } = await User.collection.insertOne({ accountName: 'skew1', email: 'skew1@x.test', passwordHash: 'x', createdAt: new Date() });
  return insertedId.toString();
}

describe('defaultProjectPrivacy deploy skew', () => {
  it('accepts an old client sending only defaultProjectPrivacy and applies nothing', async () => {
    const u = await mkUser();
    const input = { defaultProjectPrivacy: 'public' };
    await expect(updatePreferences({}, { input }, { userId: u })).resolves.toMatchObject({ defaultProjectPrivacy: 'private' });
    const stored = await UserPreferences.collection.findOne({ userId: new mongoose.Types.ObjectId(u) });
    expect(stored).not.toHaveProperty('defaultProjectPrivacy');
  });

  it('reports private even when the stored document says public', async () => {
    const u = await mkUser();
    await UserPreferences.collection.insertOne({ userId: new mongoose.Types.ObjectId(u), defaultProjectPrivacy: 'public' });
    invalidatePreferences(u);
    expect((await getPreferences(u)).defaultProjectPrivacy).toBe('private');
  });
});
