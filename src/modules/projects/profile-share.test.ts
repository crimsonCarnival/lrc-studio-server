import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../notifications/notifications.service.js', () => ({
  upsertSocial: async () => undefined,
}));
vi.mock('../badges/badge.service.js', () => ({
  triggerBadgeCheck: async () => undefined,
  updateStreak: async () => undefined,
}));
vi.mock('./projects.controller.js', () => ({ emitProjectUpdated: () => undefined }));
vi.mock('./project-view.service.js', () => ({ registerProjectView: async () => undefined }));
vi.mock('../users/music-library.service.js', () => ({ upsertMusicLibraryEntry: async () => undefined }));

import User from '../users/user.model.js';
import Project from './project.model.js';
import ProfileShare from './profile-share.model.js';
import Activity from '../activity/activity.model.js';
import Block from '../blocks/block.model.js';
import { blockUser } from '../blocks/block.service.js';
import { listProfileShares, normalizeShareNote } from './profile-share.service.js';
import { migrateBoostsToProfileShares } from './boost-to-profile-share.migration.js';
import { projectResolvers } from '../../graphql/resolvers/project.resolvers.js';
import type { Context } from '../../graphql/resolvers/context.js';

type Mutation = (root: unknown, args: { publicId: string }, ctx: Context) => Promise<boolean>;
const m = projectResolvers.Mutation as unknown as Record<'shareToProfile' | 'unshareFromProfile', Mutation>;
const ctx = (userId: string) => ({ userId }) as Context;

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([ProfileShare.init(), Block.init()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Project.deleteMany({}), ProfileShare.deleteMany({}),
    Activity.deleteMany({}), Block.deleteMany({}),
    mongoose.connection.collection('boosts').deleteMany({}),
  ]);
});

let n = 0;
async function mkUser(opts: { banned?: boolean } = {}): Promise<{ id: string; accountName: string }> {
  n++;
  const accountName = `share${n}`;
  const res = await User.collection.insertOne({
    accountName,
    email: `${accountName}@x.test`,
    isDeleted: false,
    ban: { active: !!opts.banned },
  });
  return { id: res.insertedId.toString(), accountName };
}

async function mkProject(ownerId: string, publicId: string, isPublic = true): Promise<void> {
  await Project.collection.insertOne({
    publicId, title: publicId, slug: publicId, public: isPublic,
    userId: new mongoose.Types.ObjectId(ownerId),
  });
}

/** writeActivity runs fire-and-forget; wait for the row it writes. */
async function activityCount(filter: Record<string, unknown>, expected: number): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const count = await Activity.countDocuments(filter);
    if (count === expected) return count;
    await new Promise((r) => setTimeout(r, 25));
  }
  return Activity.countDocuments(filter);
}

describe('shareToProfile / unshareFromProfile', () => {
  it('shares once, posts one feed activity, and unsharing removes both', async () => {
    const owner = await mkUser();
    const sharer = await mkUser();
    await mkProject(owner.id, 'p1');
    const row = { actorId: new mongoose.Types.ObjectId(sharer.id), type: 'project_shared', publicId: 'p1' };

    expect(await m.shareToProfile(null, { publicId: 'p1' }, ctx(sharer.id))).toBe(true);
    expect(await m.shareToProfile(null, { publicId: 'p1' }, ctx(sharer.id))).toBe(true);
    expect(await ProfileShare.countDocuments({ publicId: 'p1' })).toBe(1);
    expect(await activityCount(row, 1)).toBe(1);

    expect(await m.unshareFromProfile(null, { publicId: 'p1' }, ctx(sharer.id))).toBe(true);
    expect(await ProfileShare.countDocuments({ publicId: 'p1' })).toBe(0);
    expect(await Activity.countDocuments(row)).toBe(0);
  });

  it('lets the owner share their own project, and refuses a private one', async () => {
    const owner = await mkUser();
    const other = await mkUser();
    await mkProject(owner.id, 'own');
    await mkProject(owner.id, 'hidden', false);

    expect(await m.shareToProfile(null, { publicId: 'own' }, ctx(owner.id))).toBe(true);
    await expect(m.shareToProfile(null, { publicId: 'hidden' }, ctx(other.id))).rejects.toThrow(/not found/i);
    expect(await ProfileShare.find({}).distinct('publicId')).toEqual(['own']);
  });

  it('refuses a project whose owner is in a block relationship with you', async () => {
    const owner = await mkUser();
    const blocked = await mkUser();
    await blockUser(owner.id, blocked.id);
    await mkProject(owner.id, 'blk');

    await expect(m.shareToProfile(null, { publicId: 'blk' }, ctx(blocked.id))).rejects.toThrow(/not found/i);
  });

  it('unsharing only removes the caller\'s own share', async () => {
    const owner = await mkUser();
    const a = await mkUser();
    const b = await mkUser();
    await mkProject(owner.id, 'p2');
    await m.shareToProfile(null, { publicId: 'p2' }, ctx(a.id));
    await m.shareToProfile(null, { publicId: 'p2' }, ctx(b.id));

    await m.unshareFromProfile(null, { publicId: 'p2' }, ctx(a.id));

    expect(await ProfileShare.find({ publicId: 'p2' }).distinct('userId')).toEqual([new mongoose.Types.ObjectId(b.id)]);
  });
});

describe('normalizeShareNote', () => {
  it('trims, strips control characters, drops # and collapses case-duplicate tags', () => {
    expect(normalizeShareNote({ description: '  hi\u0007 there ', tags: ['#Rock', ' rock ', 'j-pop', '', '城'] }))
      .toEqual({ description: 'hi there', tags: ['Rock', 'j-pop', '城'] });
  });

  it('treats a missing note as empty', () => {
    expect(normalizeShareNote(undefined)).toEqual({ description: '', tags: [] });
  });

  it('rejects instead of truncating', () => {
    expect(() => normalizeShareNote({ description: 'x'.repeat(501) })).toThrow('share_description_too_long');
    expect(() => normalizeShareNote({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toThrow('share_too_many_tags');
    expect(() => normalizeShareNote({ tags: ['two words'] })).toThrow('share_tag_invalid');
    expect(() => normalizeShareNote({ tags: ['<b>'] })).toThrow('share_tag_invalid');
    expect(() => normalizeShareNote({ tags: ['x'.repeat(31)] })).toThrow('share_tag_invalid');
  });
});

describe('share note', () => {
  type ShareWithInput = (root: unknown, args: { publicId: string; input?: { description?: string; tags?: string[] } }, ctx: Context) => Promise<boolean>;
  const share = projectResolvers.Mutation.shareToProfile as unknown as ShareWithInput;

  it('stores the note on the share and its feed row, and resharing edits both without a second row', async () => {
    const owner = await mkUser();
    const sharer = await mkUser();
    await mkProject(owner.id, 'n1');
    const row = { actorId: new mongoose.Types.ObjectId(sharer.id), type: 'project_shared', publicId: 'n1' };

    await share(null, { publicId: 'n1', input: { description: 'love this', tags: ['#ballad'] } }, ctx(sharer.id));
    expect(await activityCount(row, 1)).toBe(1);
    expect(await Activity.findOne(row).lean()).toMatchObject({ description: 'love this', tags: ['ballad'] });

    await share(null, { publicId: 'n1', input: { description: 'still love it', tags: [] } }, ctx(sharer.id));

    expect(await ProfileShare.findOne({ publicId: 'n1' }).lean()).toMatchObject({ description: 'still love it', tags: [] });
    expect(await Activity.countDocuments(row)).toBe(1);
    expect(await Activity.findOne(row).lean()).toMatchObject({ description: 'still love it', tags: [] });
    const page = await listProfileShares(sharer.accountName, null);
    expect(page.items[0]).toMatchObject({ description: 'still love it', tags: [] });
  });

  it('rejects an invalid note before writing anything', async () => {
    const owner = await mkUser();
    const sharer = await mkUser();
    await mkProject(owner.id, 'n2');

    await expect(share(null, { publicId: 'n2', input: { tags: ['no spaces allowed'] } }, ctx(sharer.id)))
      .rejects.toThrow('share_tag_invalid');
    expect(await ProfileShare.countDocuments({})).toBe(0);
  });
});

describe('re-sharing', () => {
  type ShareWithInput = (root: unknown, args: { publicId: string; input?: { description?: string; reshare?: boolean } }, ctx: Context) => Promise<boolean>;
  const share = projectResolvers.Mutation.shareToProfile as unknown as ShareWithInput;

  it('moves the share to now and replaces its feed entry with a new one', async () => {
    const owner = await mkUser();
    const sharer = await mkUser();
    await mkProject(owner.id, 'r1');
    const row = { actorId: new mongoose.Types.ObjectId(sharer.id), type: 'project_shared', publicId: 'r1' };
    await share(null, { publicId: 'r1', input: { description: 'first' } }, ctx(sharer.id));
    expect(await activityCount(row, 1)).toBe(1);
    const firstActivity = await Activity.findOne(row).lean();
    await ProfileShare.collection.updateOne({ publicId: 'r1' }, { $set: { createdAt: new Date('2020-01-01') } });

    await share(null, { publicId: 'r1', input: { description: 'again', reshare: true } }, ctx(sharer.id));

    const stored = await ProfileShare.findOne({ publicId: 'r1' }).lean();
    expect(stored?.createdAt.getFullYear()).toBeGreaterThan(2020);
    expect(stored?.description).toBe('again');
    expect(await activityCount(row, 1)).toBe(1);
    const fresh = await Activity.findOne(row).lean();
    expect(String(fresh?._id)).not.toBe(String(firstActivity?._id));
    expect(fresh?.description).toBe('again');
    expect(await ProfileShare.countDocuments({ publicId: 'r1' })).toBe(1);
  });
});

describe('listProfileShares', () => {
  it('lists shares newest first and skips projects that went private', async () => {
    const owner = await mkUser();
    const sharer = await mkUser();
    await mkProject(owner.id, 'old');
    await mkProject(owner.id, 'new');
    await mkProject(owner.id, 'gone', false);
    const uid = new mongoose.Types.ObjectId(sharer.id);
    await ProfileShare.collection.insertMany([
      { userId: uid, publicId: 'old', createdAt: new Date('2026-01-01') },
      { userId: uid, publicId: 'new', createdAt: new Date('2026-03-01') },
      { userId: uid, publicId: 'gone', createdAt: new Date('2026-02-01') },
    ]);

    const page = await listProfileShares(sharer.accountName, null);

    expect(page.items.map((i) => i.project.publicId)).toEqual(['new', 'old']);
    expect(page.items[0].sharedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(page.hasMore).toBe(false);
  });

  it('is empty for a banned sharer, and between users in a block relationship', async () => {
    const owner = await mkUser();
    const banned = await mkUser({ banned: true });
    const sharer = await mkUser();
    const viewer = await mkUser();
    await mkProject(owner.id, 'p');
    await ProfileShare.create([
      { userId: banned.id, publicId: 'p' },
      { userId: sharer.id, publicId: 'p' },
    ]);
    await blockUser(sharer.id, viewer.id);

    expect((await listProfileShares(banned.accountName, null)).items).toEqual([]);
    expect((await listProfileShares(sharer.accountName, viewer.id)).items).toEqual([]);
    expect((await listProfileShares(sharer.accountName, null)).items).toHaveLength(1);
  });

  it('pages with hasMore', async () => {
    const owner = await mkUser();
    const sharer = await mkUser();
    await Promise.all(['a', 'b', 'c'].map((id) => mkProject(owner.id, id)));
    await ProfileShare.create(['a', 'b', 'c'].map((publicId) => ({ userId: sharer.id, publicId })));

    const first = await listProfileShares(sharer.accountName, null, 0, 2);
    const second = await listProfileShares(sharer.accountName, null, 2, 2);

    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });
});

describe('migrateBoostsToProfileShares', () => {
  it('copies boosts with their dates, renames activities, and is a no-op on re-run', async () => {
    const userId = new mongoose.Types.ObjectId();
    const createdAt = new Date('2025-12-24T10:00:00Z');
    await mongoose.connection.collection('boosts').insertOne({ userId, publicId: 'x', createdAt });
    await Activity.collection.insertOne({ actorId: userId, type: 'project_boosted', publicId: 'x', createdAt });

    expect(await migrateBoostsToProfileShares({ dryRun: true })).toEqual({ scanned: 1, inserted: 0, activitiesRenamed: 1 });
    expect(await ProfileShare.countDocuments({})).toBe(0);

    expect(await migrateBoostsToProfileShares()).toEqual({ scanned: 1, inserted: 1, activitiesRenamed: 1 });
    const share = await ProfileShare.findOne({ userId, publicId: 'x' }).lean();
    expect(share?.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(await Activity.countDocuments({ type: 'project_shared', publicId: 'x' })).toBe(1);

    expect(await migrateBoostsToProfileShares()).toEqual({ scanned: 1, inserted: 0, activitiesRenamed: 0 });
    expect(await ProfileShare.countDocuments({})).toBe(1);
  });
});
