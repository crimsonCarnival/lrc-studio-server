/**
 * Private projects must not leak through edges that bypass the top-level
 * `project` query: star/unstar payloads, Upload.projects (forks share the
 * source's uploadId) and the Project.lyrics field.
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
import ProjectStar from '../../modules/projects/project-star.model.js';
import { projectResolvers } from './project.resolvers.js';
import { uploadResolvers } from './upload.resolvers.js';
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
  await Promise.all([User.deleteMany({}), Project.deleteMany({}), ProjectStar.deleteMany({})]);
});

let n = 0;
async function mkUser(permissions: string[] = []): Promise<string> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `pv${n}`,
    email: `pv${n}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    role: permissions.length ? 'mod' : 'user',
    permissions,
    ban: { active: false, reason: null, until: null },
    social: { followerCount: 0, followingCount: 0, totalStarsReceived: 0, totalForksReceived: 0 },
  });
  return res.insertedId.toString();
}

async function mkProject(ownerId: string, publicId: string, isPublic: boolean, uploadId?: mongoose.Types.ObjectId) {
  await Project.collection.insertOne({
    publicId,
    userId: new mongoose.Types.ObjectId(ownerId),
    title: `secret-${publicId}`,
    public: isPublic,
    uploadId: uploadId ?? null,
    starCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const ctx = (userId?: string): Context => ({ userId, ip: '198.51.100.1', tokenExpired: false } as Context);
type Resolver = (root: unknown, args: Record<string, unknown>, context: Context) => Promise<unknown>;
const m = projectResolvers.Mutation as unknown as Record<string, Resolver>;
const projectField = projectResolvers.Project as unknown as Record<string, Resolver>;
const uploadField = uploadResolvers.Upload as unknown as Record<string, Resolver>;

describe('starProject / unstarProject', () => {
  it("refuses to star another user's private project and writes nothing", async () => {
    const owner = await mkUser();
    const other = await mkUser();
    await mkProject(owner, 'priv0000001', false);
    await expect(m.starProject(null, { id: 'priv0000001' }, ctx(other))).rejects.toThrow('Project not found');
    expect(await ProjectStar.countDocuments({})).toBe(0);
  });

  it('returns only the counter fields, not the project content', async () => {
    const owner = await mkUser();
    const other = await mkUser();
    await mkProject(owner, 'pub00000001', true);
    const starred = await m.starProject(null, { id: 'pub00000001' }, ctx(other)) as { title?: string; starCount?: number };
    expect(starred.starCount).toBe(1);
    expect(starred.title).toBeUndefined();
    const unstarred = await m.unstarProject(null, { id: 'pub00000001' }, ctx(other)) as { title?: string };
    expect(unstarred.title).toBeUndefined();
  });
});

describe('Upload.projects', () => {
  it('hides private projects that share the upload from other viewers', async () => {
    const owner = await mkUser();
    const forker = await mkUser();
    const uploadId = new mongoose.Types.ObjectId();
    await mkProject(owner, 'source00001', true, uploadId);
    await mkProject(forker, 'forkpriv001', false, uploadId);

    const anon = await uploadField.projects({ _id: uploadId }, {}, ctx()) as { publicId: string }[];
    expect(anon.map(p => p.publicId)).toEqual(['source00001']);

    const own = await uploadField.projects({ _id: uploadId }, {}, ctx(forker)) as { publicId: string }[];
    expect(own.map(p => p.publicId).sort()).toEqual(['forkpriv001', 'source00001']);

    const staff = await mkUser(['users.view']);
    const all = await uploadField.projects({ _id: uploadId }, {}, ctx(staff)) as unknown[];
    expect(all).toHaveLength(2);
  });
});

describe('Project.lyrics', () => {
  it('resolves to null for a private project the viewer does not own', async () => {
    const owner = await mkUser();
    const other = await mkUser();
    const parent = { publicId: 'priv0000002', public: false, userId: owner, lyrics: { sections: [] } };
    expect(await projectField.lyrics(parent, {}, ctx(other))).toBeNull();
    expect(await projectField.lyrics(parent, {}, ctx(owner))).toEqual({ sections: [] });
  });
});
