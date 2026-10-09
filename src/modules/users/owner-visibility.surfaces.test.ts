/**
 * Owner-visibility as the reader experiences it.
 *
 * owner-visibility.test.ts proves the flags are computed and maintained
 * correctly. These assert the consequence on each surface that leaked, and —
 * just as importantly — that the surfaces which should NOT hide content still
 * show it: a shadow-banned project opens by link, and an owner always sees
 * their own work.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../badges/badge.service.js', () => ({
  recomputeSyncStats: async () => undefined,
  scheduleSyncStatsRefresh: () => undefined,
  triggerBadgeCheck: async () => undefined,
  updateStreak: async () => undefined,
}));
vi.mock('../activity/activity.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordHeatmapEvent: async () => undefined,
}));

import User from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import Playlist from '../../db/playlist.model.js';
import Follow from '../../db/follow.model.js';
import Activity from '../../db/activity.model.js';
import { getProject } from '../projects/projects.crud.service.js';
import { getTrendingProjects, getPopularPlaylists, getExploreStats } from '../explore/explore.service.js';
import { getFeed } from '../activity/activity.service.js';
import { syncOwnerVisibility } from './owner-visibility.service.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Project.init(), Playlist.init(), Follow.init(), Activity.init()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Project.deleteMany({}), Playlist.deleteMany({}),
    Follow.deleteMany({}), Activity.deleteMany({}),
  ]);
});

let n = 0;
type State = { deleted?: boolean; banned?: boolean; shadowSearch?: boolean; shadowFeed?: boolean };
async function mkUser(state: State = {}): Promise<string> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `surf${n}`,
    email: `surf${n}@x.test`,
    passwordHash: 'x',
    isDeleted: !!state.deleted,
    deletedAt: state.deleted ? new Date() : null,
    role: 'user',
    permissions: [],
    ban: { active: !!state.banned, reason: null, until: null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
    shadowBan: {
      feed: !!state.shadowFeed, search: !!state.shadowSearch,
      reason: null, appliedAt: null, appliedBy: null,
    },
  });
  return res.insertedId.toString();
}

let pid = 0;
/** Creates a public project and syncs the owner-visibility flags, as the app would. */
async function mkProject(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  pid++;
  const publicId = `surf-proj-${pid}`;
  await Project.create({
    publicId,
    userId: new mongoose.Types.ObjectId(userId),
    title: 'Song',
    public: true,
    trendingScore: 10,
    ...extra,
  });
  await syncOwnerVisibility(userId);
  return publicId;
}

async function mkPlaylist(userId: string): Promise<void> {
  await Playlist.create({ userId: new mongoose.Types.ObjectId(userId), name: 'List', isPublic: true, trendingScore: 5 });
  await syncOwnerVisibility(userId);
}

const trendingIds = async (viewerId?: string): Promise<string[]> => {
  const { projects } = await getTrendingProjects(0, 50, viewerId);
  return (projects as { publicId: string }[]).map((p) => p.publicId);
};

describe('trending projects', () => {
  it('lists a healthy owner\'s project', async () => {
    const p = await mkProject(await mkUser());
    expect(await trendingIds()).toContain(p);
  });

  it('hides a deactivated owner\'s project', async () => {
    const p = await mkProject(await mkUser({ deleted: true }));
    expect(await trendingIds()).not.toContain(p);
  });

  it('hides a banned owner\'s project', async () => {
    const p = await mkProject(await mkUser({ banned: true }));
    expect(await trendingIds()).not.toContain(p);
  });

  it('hides a shadow-banned owner\'s project', async () => {
    const p = await mkProject(await mkUser({ shadowSearch: true }));
    expect(await trendingIds()).not.toContain(p);
  });

  it('still lists a feed-only shadow-banned owner\'s project', async () => {
    const p = await mkProject(await mkUser({ shadowFeed: true }));
    expect(await trendingIds()).toContain(p);
  });

  it('reports a total consistent with what it returned', async () => {
    await mkProject(await mkUser());
    await mkProject(await mkUser({ banned: true }));
    const { projects, total } = await getTrendingProjects(0, 50);
    expect(total).toBe((projects as unknown[]).length);
    expect(total).toBe(1);
  });

  it('re-lists the project once the owner is restored', async () => {
    const u = await mkUser({ deleted: true });
    const p = await mkProject(u);
    expect(await trendingIds()).not.toContain(p);

    await User.updateOne({ _id: u }, { $set: { isDeleted: false, deletedAt: null } });
    await syncOwnerVisibility(u);
    expect(await trendingIds()).toContain(p);
  });
});

describe('popular playlists', () => {
  it('counts only listed owners\' playlists in the explore stats', async () => {
    // Asserted through getExploreStats because getPopularPlaylists itself
    // throws before it can return — see FINDING J below.
    await mkPlaylist(await mkUser());
    await mkPlaylist(await mkUser({ deleted: true }));
    await mkPlaylist(await mkUser({ shadowSearch: true }));

    const stats = await getExploreStats();
    expect(stats.totalPlaylists).toBe(1);
  });

  it('counts only listed owners\' projects in the explore stats', async () => {
    await mkProject(await mkUser());
    await mkProject(await mkUser({ banned: true }));
    const stats = await getExploreStats();
    expect(stats.totalProjects).toBe(1);
  });

  /**
   * FINDING J — `popularPlaylists` throws on every call. Pre-existing, found
   * while testing this change; not caused by it.
   *
   * `getPopularPlaylists` does `.populate('owner', …)`, but the Playlist schema
   * field is `userId` — there is no `owner` path — so Mongoose 8's default
   * `strictPopulate` rejects it with StrictPopulateError and the resolver 500s.
   * The Explore page's popular-playlists section is therefore dead.
   *
   * The populate was trying to fill the GraphQL `Playlist.owner` field, which
   * every other playlist query builds by passing documents through
   * `formatPlaylist()`. The fix is to do the same here and drop the populate —
   * deliberately left out of this change, since it is an unrelated bug that
   * deserves its own commit and its own test.
   *
   * Remove the `.fails` marker once popularPlaylists returns.
   */
  it.fails('should return without throwing (FINDING J)', async () => {
    await mkPlaylist(await mkUser());
    await expect(getPopularPlaylists(0, 50)).resolves.toBeDefined();
  });
});

describe('direct project read', () => {
  it('serves a healthy owner\'s public project', async () => {
    const p = await mkProject(await mkUser());
    expect(await getProject(p, null)).not.toBeNull();
  });

  it('404s a deactivated owner\'s project for a visitor', async () => {
    const p = await mkProject(await mkUser({ deleted: true }));
    expect(await getProject(p, null)).toBeNull();
  });

  it('404s a banned owner\'s project — otherwise the ban is bypassed by sharing the link', async () => {
    const p = await mkProject(await mkUser({ banned: true }));
    expect(await getProject(p, null)).toBeNull();
  });

  it('STILL serves a shadow-banned owner\'s project by link', async () => {
    // Load-bearing: hiding this would make the shadow ban detectable by its
    // target, which is the one property it must keep.
    const p = await mkProject(await mkUser({ shadowSearch: true }));
    expect(await getProject(p, null)).not.toBeNull();
  });

  it('still serves the project to its own owner while they are banned', async () => {
    const u = await mkUser({ banned: true });
    const p = await mkProject(u);
    expect(await getProject(p, u)).not.toBeNull();
  });

  it('does not leak another user\'s hidden project to a logged-in visitor', async () => {
    const owner = await mkUser({ banned: true });
    const visitor = await mkUser();
    const p = await mkProject(owner);
    expect(await getProject(p, visitor)).toBeNull();
  });
});

describe('activity feed', () => {
  async function follows(followerId: string, actorId: string): Promise<void> {
    await Follow.create({
      followerId: new mongoose.Types.ObjectId(followerId),
      followingId: new mongoose.Types.ObjectId(actorId),
    });
  }
  async function activity(actorId: string): Promise<void> {
    await Activity.create({
      actorId: new mongoose.Types.ObjectId(actorId),
      type: 'project_published',
      publicId: `feed-${actorId}`,
      projectTitle: 'Song',
    });
  }

  it('shows a followed healthy user\'s activity', async () => {
    const viewer = await mkUser();
    const actor = await mkUser();
    await follows(viewer, actor);
    await activity(actor);
    expect((await getFeed(viewer)).activities).toHaveLength(1);
  });

  it('hides a deactivated user\'s activity — deactivating does not sever follow edges', async () => {
    const viewer = await mkUser();
    const actor = await mkUser({ deleted: true });
    await follows(viewer, actor);
    await activity(actor);
    expect((await getFeed(viewer)).activities).toHaveLength(0);
  });

  it('hides a banned user\'s activity', async () => {
    const viewer = await mkUser();
    const actor = await mkUser({ banned: true });
    await follows(viewer, actor);
    await activity(actor);
    expect((await getFeed(viewer)).activities).toHaveLength(0);
  });

  it('hides a feed-shadow-banned user\'s activity', async () => {
    const viewer = await mkUser();
    const actor = await mkUser({ shadowFeed: true });
    await follows(viewer, actor);
    await activity(actor);
    expect((await getFeed(viewer)).activities).toHaveLength(0);
  });

  it('keeps a search-only shadow ban out of the feed filter', async () => {
    const viewer = await mkUser();
    const actor = await mkUser({ shadowSearch: true });
    await follows(viewer, actor);
    await activity(actor);
    expect((await getFeed(viewer)).activities).toHaveLength(1);
  });

  it('keeps the healthy actors when one followed user is hidden', async () => {
    const viewer = await mkUser();
    const good = await mkUser();
    const bad = await mkUser({ deleted: true });
    await follows(viewer, good);
    await follows(viewer, bad);
    await activity(good);
    await activity(bad);

    const { activities } = await getFeed(viewer);
    expect(activities).toHaveLength(1);
  });
});
