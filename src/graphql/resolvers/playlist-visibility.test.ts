/**
 * Playlist read paths must not leak private content: a public list's private
 * entries stay hidden from everyone but their owner, and the paged queries
 * never hand a non-owner a private list.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../../modules/notifications/notifications.events.js', () => ({
  notifyPlaylistSaved: async () => undefined,
}));
vi.mock('../../modules/activity/activity.service.js', () => ({
  writeActivity: async () => undefined,
  getPublicActivityHeatmap: async () => [],
  recordHeatmapEvent: async () => undefined,
}));

import User from '../../modules/users/user.model.js';
import Project from '../../modules/projects/project.model.js';
import Playlist from '../../modules/playlists/playlist.model.js';
import SavedPlaylist from '../../modules/playlists/saved-playlist.model.js';
import { playlistResolvers } from './playlist.resolvers.js';
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
  await Promise.all([
    User.deleteMany({}),
    Project.deleteMany({}),
    Playlist.deleteMany({}),
    SavedPlaylist.deleteMany({}),
  ]);
});

let n = 0;
async function mkUser(): Promise<{ id: string; accountName: string }> {
  n++;
  const accountName = `plv${n}`;
  const res = await User.collection.insertOne({
    accountName,
    email: `plv${n}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    role: 'user',
    permissions: [],
    ban: { active: false, reason: null, until: null },
    social: { followerCount: 0, followingCount: 0, totalStarsReceived: 0, totalForksReceived: 0 },
  });
  return { id: res.insertedId.toString(), accountName };
}

async function mkProject(ownerId: string, publicId: string, isPublic: boolean): Promise<mongoose.Types.ObjectId> {
  const res = await Project.collection.insertOne({
    publicId,
    userId: new mongoose.Types.ObjectId(ownerId),
    title: `title-${publicId}`,
    public: isPublic,
    starCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return res.insertedId;
}

async function mkPlaylist(
  ownerId: string,
  opts: { name?: string; isPublic?: boolean; publicIds?: mongoose.Types.ObjectId[]; tags?: string[] } = {},
): Promise<string> {
  const doc = await Playlist.create({
    userId: new mongoose.Types.ObjectId(ownerId),
    name: opts.name ?? 'list',
    isPublic: opts.isPublic ?? true,
    tags: opts.tags ?? [],
    publicIds: opts.publicIds ?? [],
    sortMode: 'MANUAL',
  });
  return doc._id.toString();
}

const ctx = (userId?: string): Context => ({ userId, ip: '198.51.100.1', tokenExpired: false } as Context);
type Resolver = (root: unknown, args: Record<string, unknown>, context: Context) => Promise<unknown>;
const q = playlistResolvers.Query as unknown as Record<string, Resolver>;

type ListShape = { name: string; isPublic: boolean; projectCount: number; projects: { publicId: string }[] };
type PageShape = { playlists: ListShape[]; total: number; hasMore: boolean };

describe('Playlist.projects visibility', () => {
  it("hides a private project in a public list from others, shows it to its owner", async () => {
    const owner = await mkUser();
    const other = await mkUser();
    const pub = await mkProject(owner.id, 'pub00000001', true);
    const priv = await mkProject(owner.id, 'priv0000001', false);
    const listId = await mkPlaylist(owner.id, { publicIds: [priv, pub] });

    for (const viewer of [undefined, other.id]) {
      const list = await q.playlist(null, { id: listId }, ctx(viewer)) as ListShape;
      expect(list.projects.map(p => p.publicId)).toEqual(['pub00000001']);
      expect(list.projectCount).toBe(1);
    }

    const own = await q.playlist(null, { id: listId }, ctx(owner.id)) as ListShape;
    expect(own.projects.map(p => p.publicId)).toEqual(['priv0000001', 'pub00000001']);
    expect(own.projectCount).toBe(2);
  });

  it("hides a public project whose owner is no longer active", async () => {
    const owner = await mkUser();
    const banned = await mkUser();
    const gone = await mkProject(banned.id, 'gone0000001', true);
    await Project.updateOne({ _id: gone }, { $set: { ownerActive: false } });
    const listId = await mkPlaylist(owner.id, { publicIds: [gone] });
    const list = await q.playlist(null, { id: listId }, ctx(owner.id)) as ListShape;
    expect(list.projects).toEqual([]);
    expect(list.projectCount).toBe(0);
  });
});

describe('playlistsPage', () => {
  it('never returns private lists to a non-owner, even with visibility PRIVATE', async () => {
    const owner = await mkUser();
    const other = await mkUser();
    await mkPlaylist(owner.id, { name: 'open', isPublic: true });
    await mkPlaylist(owner.id, { name: 'hidden', isPublic: false });

    for (const viewer of [undefined, other.id]) {
      const page = await q.playlistsPage(null, { accountName: owner.accountName, visibility: 'PRIVATE' }, ctx(viewer)) as PageShape;
      expect(page.playlists.map(p => p.name)).toEqual(['open']);
      expect(page.total).toBe(1);
    }
  });

  it('gives the owner only private lists with visibility PRIVATE', async () => {
    const owner = await mkUser();
    await mkPlaylist(owner.id, { name: 'open', isPublic: true });
    await mkPlaylist(owner.id, { name: 'hidden', isPublic: false });
    const page = await q.playlistsPage(null, { accountName: owner.accountName, visibility: 'PRIVATE' }, ctx(owner.id)) as PageShape;
    expect(page.playlists.map(p => p.name)).toEqual(['hidden']);
    const all = await q.playlistsPage(null, { accountName: owner.accountName }, ctx(owner.id)) as PageShape;
    expect(all.total).toBe(2);
  });

  it('treats search input as a literal, matches name or tag', async () => {
    const owner = await mkUser();
    await mkPlaylist(owner.id, { name: 'Night Drive' });
    await mkPlaylist(owner.id, { name: 'other', tags: ['jpop'] });
    const odd = await q.playlistsPage(null, { accountName: owner.accountName, search: 'a.*(' }, ctx()) as PageShape;
    expect(odd.playlists).toEqual([]);
    const byName = await q.playlistsPage(null, { accountName: owner.accountName, search: '  night ' }, ctx()) as PageShape;
    expect(byName.playlists.map(p => p.name)).toEqual(['Night Drive']);
    const byTag = await q.playlistsPage(null, { accountName: owner.accountName, search: 'JPOP' }, ctx()) as PageShape;
    expect(byTag.playlists.map(p => p.name)).toEqual(['other']);
  });

  it('pages with clamped limits and sorts by name case-insensitively', async () => {
    const owner = await mkUser();
    for (const name of ['beta', 'Alpha', 'gamma']) await mkPlaylist(owner.id, { name });
    const first = await q.playlistsPage(null, { accountName: owner.accountName, sort: 'NAME', limit: 2 }, ctx()) as PageShape;
    expect(first.playlists.map(p => p.name)).toEqual(['Alpha', 'beta']);
    expect(first).toMatchObject({ total: 3, hasMore: true });
    const second = await q.playlistsPage(null, { accountName: owner.accountName, sort: 'NAME', limit: 2, offset: 2 }, ctx()) as PageShape;
    expect(second.playlists.map(p => p.name)).toEqual(['gamma']);
    expect(second.hasMore).toBe(false);
    const zero = await q.playlistsPage(null, { accountName: owner.accountName, limit: 0, offset: -5 }, ctx()) as PageShape;
    expect(zero.playlists).toHaveLength(1);
  });
});

describe('savedPlaylistsPage', () => {
  it('requires auth', async () => {
    await expect(q.savedPlaylistsPage(null, {}, ctx())).rejects.toThrow('unauthorized');
  });

  it('pages over eligible saves only, newest save first', async () => {
    const owner = await mkUser();
    const viewer = await mkUser();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await mkPlaylist(owner.id, { name: `l${i}` }));
    // Saved newest-first order: l3, l2, l1, l0.
    for (let i = 0; i < 4; i++) {
      await SavedPlaylist.create({
        userId: new mongoose.Types.ObjectId(viewer.id),
        playlistId: new mongoose.Types.ObjectId(ids[i]),
        savedAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }
    // The two newest saves stop being visible after they were saved.
    await Playlist.updateOne({ _id: ids[3] }, { $set: { isPublic: false } });
    await Playlist.updateOne({ _id: ids[2] }, { $set: { ownerActive: false } });

    const first = await q.savedPlaylistsPage(null, { limit: 1 }, ctx(viewer.id)) as PageShape;
    expect(first.playlists.map(p => p.name)).toEqual(['l1']);
    expect(first).toMatchObject({ total: 2, hasMore: true });
    const second = await q.savedPlaylistsPage(null, { limit: 1, offset: 1 }, ctx(viewer.id)) as PageShape;
    expect(second.playlists.map(p => p.name)).toEqual(['l0']);
    expect(second.hasMore).toBe(false);
  });
});
