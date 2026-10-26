/**
 * Resolver-level consequences of a ban, a shadow ban and a block.
 *
 * The decorator tests cover whether a banned user can authenticate; these cover
 * whether a banned, shadow-banned or blocked user is still *visible* and still
 * able to *act* — which is where the moderation surfaces actually disagree with
 * each other.
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

import User from '../../db/user.model.js';
import Project from '../../modules/projects/project.model.js';
import ProjectStar from '../../modules/projects/projectStar.model.js';
import Block from '../../db/block.model.js';
import Follow from '../../db/follow.model.js';
import AdminLog from '../../modules/admin/adminLog.model.js';
import { blockUser } from '../../modules/blocks/block.service.js';
import { userResolvers } from './user.resolvers.js';
import { projectResolvers } from './project.resolvers.js';
import type { Context } from './context.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Block.init(), Follow.init(), ProjectStar.init()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Project.deleteMany({}), ProjectStar.deleteMany({}),
    Block.deleteMany({}), Follow.deleteMany({}), AdminLog.deleteMany({}),
  ]);
});

let n = 0;
async function mkUser(opts: {
  role?: string;
  permissions?: string[];
  banned?: boolean;
  shadowFeed?: boolean;
  shadowSearch?: boolean;
  rankScore?: number;
} = {}): Promise<{ id: string; accountName: string }> {
  n++;
  const accountName = `vis${n}`;
  const res = await User.collection.insertOne({
    accountName,
    email: `${accountName}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    role: opts.role ?? 'user',
    permissions: opts.permissions ?? [],
    ban: { active: !!opts.banned, reason: opts.banned ? 'spam' : null, until: null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
    shadowBan: {
      feed: !!opts.shadowFeed,
      search: !!opts.shadowSearch,
      reason: null, appliedAt: null, appliedBy: null,
    },
    rankScore: opts.rankScore ?? 0,
    projectCount: 0,
    badges: [],
    showcasedBadges: [],
    stats: { syncedLines: 0, minutesSynced: 0, secondsSynced: 0 },
    streak: { currentStreak: 0, longestStreak: 0, lastActiveDate: null },
    progression: { xp: 0, level: 0 },
    social: { followerCount: 0, followingCount: 0, totalStarsReceived: 0, totalForksReceived: 0 },
  });
  return { id: res.insertedId.toString(), accountName };
}

async function mkProject(ownerId: string, publicId: string): Promise<void> {
  await Project.collection.insertOne({
    publicId,
    userId: new mongoose.Types.ObjectId(ownerId),
    title: 'Song',
    public: true,
    starCount: 0,
    forkCount: 0,
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const ctx = (userId?: string, extra: Partial<Context> = {}): Context =>
  ({ userId, ip: '198.51.100.1', tokenExpired: false, ...extra } as Context);

type Resolver<A> = (root: unknown, args: A, context: Context) => Promise<unknown>;
const q = userResolvers.Query as unknown as Record<string, Resolver<Record<string, unknown>>>;
const m = userResolvers.Mutation as unknown as Record<string, Resolver<Record<string, unknown>>>;
const pm = projectResolvers.Mutation as unknown as Record<string, Resolver<Record<string, unknown>>>;

describe('publicProfile — ban and block visibility', () => {
  it('serves a normal profile', async () => {
    const u = await mkUser();
    const res = await q.publicProfile(null, { accountName: u.accountName }, ctx());
    expect(res).not.toBeNull();
  });

  it('hides a banned user from everyone', async () => {
    const u = await mkUser({ banned: true });
    expect(await q.publicProfile(null, { accountName: u.accountName }, ctx())).toBeNull();
  });

  it('is case-insensitive on the account name, so casing cannot dodge the ban check', async () => {
    const u = await mkUser({ banned: true });
    const res = await q.publicProfile(null, { accountName: u.accountName.toUpperCase() }, ctx());
    expect(res).toBeNull();
  });

  it('hides the profile from a user the owner blocked', async () => {
    const owner = await mkUser();
    const blocked = await mkUser();
    await blockUser(owner.id, blocked.id);
    expect(await q.publicProfile(null, { accountName: owner.accountName }, ctx(blocked.id))).toBeNull();
  });

  it('still shows the profile to someone the owner merely blocked in the other direction', async () => {
    const owner = await mkUser();
    const viewer = await mkUser();
    // The viewer blocked the owner, not the reverse — the viewer chose to hide
    // them from their own feed, not to lose access to the page.
    await blockUser(viewer.id, owner.id);
    expect(await q.publicProfile(null, { accountName: owner.accountName }, ctx(viewer.id))).not.toBeNull();
  });

  it('does not hide a shadow-banned user from a direct visit — that is the point of a shadow ban', async () => {
    const u = await mkUser({ shadowFeed: true, shadowSearch: true });
    expect(await q.publicProfile(null, { accountName: u.accountName }, ctx())).not.toBeNull();
  });
});

describe('leaderboard — moderation visibility', () => {
  async function names(): Promise<string[]> {
    const res = await q.leaderboard(null, { limit: 50, offset: 0, timeframe: 'ALL_TIME' }, ctx()) as {
      users: { accountName?: string }[];
    };
    return res.users.map((u) => u.accountName ?? '');
  }

  it('lists an ordinary user', async () => {
    const u = await mkUser({ rankScore: 10 });
    expect(await names()).toContain(u.accountName);
  });

  it('excludes a soft-deleted user', async () => {
    const u = await mkUser({ rankScore: 10 });
    await User.updateOne({ _id: u.id }, { $set: { isDeleted: true } });
    expect(await names()).not.toContain(u.accountName);
  });

  // FINDING C, fixed: the leaderboard now shares one predicate with the other
  // discovery surfaces (LEADERBOARD_VISIBLE), rather than filtering `isDeleted`
  // alone and leaving banned users publicly ranked.
  it('excludes a banned user', async () => {
    const u = await mkUser({ rankScore: 10, banned: true });
    expect(await names()).not.toContain(u.accountName);
  });

  it('excludes a search-shadow-banned user, so the shadow ban is not undone by the board', async () => {
    const u = await mkUser({ rankScore: 10, shadowSearch: true });
    expect(await names()).not.toContain(u.accountName);
  });

  it('still lists a feed-only shadow-banned user — that switch is not about search', async () => {
    const u = await mkUser({ rankScore: 10, shadowFeed: true });
    expect(await names()).toContain(u.accountName);
  });
});

describe('adminShadowBan — authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    const target = await mkUser();
    await expect(
      m.adminShadowBan(null, { userId: target.id, feed: true, search: true }, ctx(undefined, { hasSudo: true })),
    ).rejects.toThrow(/unauthorized/i);
  });

  it('rejects a staff member without users.shadowban', async () => {
    const mod = await mkUser({ role: 'mod', permissions: ['users.view'] });
    const target = await mkUser();
    await expect(
      m.adminShadowBan(null, { userId: target.id, feed: true, search: true }, ctx(mod.id, { hasSudo: true })),
    ).rejects.toThrow(/forbidden/i);
  });

  it('applies the shadow ban for a permitted actor holding sudo', async () => {
    const admin = await mkUser({ role: 'superadmin', permissions: ['users.shadowban'] });
    const target = await mkUser();
    const ok = await m.adminShadowBan(
      null, { userId: target.id, feed: true, search: false, reason: 'brigading' },
      ctx(admin.id, { hasSudo: true }),
    );
    expect(ok).toBe(true);
    const doc = await User.findById(target.id).lean<{ shadowBan?: { feed?: boolean } }>();
    expect(doc?.shadowBan?.feed).toBe(true);
  });

  /**
   * Shadow-ban via GraphQL requires the same sudo grant as the REST route
   * (admin.routes.ts), read from context.hasSudo.
   */
  it('rejects adminShadowBan without a sudo grant', async () => {
    const admin = await mkUser({ role: 'superadmin', permissions: ['users.shadowban'] });
    const target = await mkUser();
    await expect(
      m.adminShadowBan(null, { userId: target.id, feed: true, search: true }, ctx(admin.id)),
    ).rejects.toThrow();
  });

  it('rejects adminUnshadowBan without a sudo grant', async () => {
    const admin = await mkUser({ role: 'superadmin', permissions: ['users.shadowban'] });
    const target = await mkUser({ shadowFeed: true, shadowSearch: true });
    await expect(
      m.adminUnshadowBan(null, { userId: target.id }, ctx(admin.id)),
    ).rejects.toThrow();
  });
});

describe('block enforcement on engagement', () => {
  it('rejects following a user who blocked you', async () => {
    const owner = await mkUser();
    const blocked = await mkUser();
    await blockUser(owner.id, blocked.id);
    await expect(
      m.follow(null, { accountName: owner.accountName }, ctx(blocked.id)),
    ).rejects.toThrow(/cannot follow/i);
  });

  it('rejects following in the other direction too — the guard is symmetric', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a.id, b.id);
    await expect(
      m.follow(null, { accountName: b.accountName }, ctx(a.id)),
    ).rejects.toThrow(/cannot follow/i);
  });

  it('rejects following a banned user', async () => {
    const banned = await mkUser({ banned: true });
    const viewer = await mkUser();
    await expect(
      m.follow(null, { accountName: banned.accountName }, ctx(viewer.id)),
    ).rejects.toThrow(/not found/i);
  });

  /**
   * A block must stop engagement, not just discovery. starProject refuses a
   * project whose owner is in a block relationship with the caller (same guard
   * as followUser) and leaves no star, counter bump or notification behind.
   * cloneProject, boostProject and reactToProject share the guard.
   */
  it('rejects starring a project owned by someone who blocked you, with no side effects', async () => {
    const owner = await mkUser();
    const blocked = await mkUser();
    await blockUser(owner.id, blocked.id);
    await mkProject(owner.id, 'proj-blk-1');

    await expect(
      pm.starProject(null, { id: 'proj-blk-1' }, ctx(blocked.id)),
    ).rejects.toThrow(/not found/i);

    expect(await ProjectStar.countDocuments({ publicId: 'proj-blk-1' })).toBe(0);
    const doc = await Project.findOne({ publicId: 'proj-blk-1' }).lean<{ starCount?: number }>();
    expect(doc?.starCount ?? 0).toBe(0);
  });
});
