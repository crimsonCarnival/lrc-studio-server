/**
 * Playlist read paths must not leak private content: a public list's private
 * entries stay hidden from everyone but their owner.
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
