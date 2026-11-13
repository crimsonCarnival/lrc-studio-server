/**
 * The public_project_count badge check belongs to the publish path only:
 * createProject always creates private (even with public:true input), so it
 * must not fire there; updateProject public:true must still fire it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const triggerBadgeCheck = vi.fn(async () => undefined);

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../../modules/auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));
vi.mock('../../modules/user-logs/logs.service.js', () => ({ logUserAction: () => undefined }));
vi.mock('../../lib/job-queue.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), scheduleOnce: async () => undefined }));
vi.mock('../../modules/badges/badge.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  triggerBadgeCheck: (...args: unknown[]) => (triggerBadgeCheck as (...a: unknown[]) => Promise<void>)(...args),
  updateStreak: async () => undefined,
  scheduleSyncStatsRefresh: () => undefined,
}));
vi.mock('../../modules/projects/projects.controller.js', () => ({ emitProjectUpdated: () => undefined }));
vi.mock('../../modules/users/music-library.service.js', () => ({ upsertMusicLibraryEntry: async () => undefined }));

import Project from '../../modules/projects/project.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import User from '../../modules/users/user.model.js';
import { projectResolvers } from './project.resolvers.js';
import type { Context } from './context.js';

let repl: MongoMemoryReplSet;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Project.init(), Lyrics.init(), User.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  triggerBadgeCheck.mockClear();
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), User.deleteMany({})]);
});

type Resolver = (root: unknown, args: Record<string, unknown>, context: Context) => Promise<unknown>;
const m = projectResolvers.Mutation as unknown as Record<string, Resolver>;
const ctx = (userId: string): Context => ({ userId, ip: '198.51.100.1', tokenExpired: false } as Context);
const flush = () => new Promise((r) => setTimeout(r, 50));

async function mkUser(): Promise<string> {
  const { insertedId } = await User.collection.insertOne({ accountName: 'badgeuser', email: 'b@x.test', passwordHash: 'x', createdAt: new Date() });
  return insertedId.toString();
}

describe('project_publish badge check', () => {
  it('does not fire on createProject, even with public:true input', async () => {
    const u = await mkUser();
    await m.createProject({}, { input: { title: 'T', public: true, recaptchaToken: 'x' } }, ctx(u));
    await flush();
    const calls = triggerBadgeCheck.mock.calls.map((c) => (c as unknown[])[1]);
    expect(calls).toContain('project_create');
    expect(calls).not.toContain('project_publish');
  });

  it('still fires on updateProject public:true', async () => {
    const u = await mkUser();
    const created = await m.createProject({}, { input: { title: 'T', lyrics: { editorMode: 'lrc', sections: [{ label: 'V', lines: [{ text: 'a', timestamp: 1 }] }] }, recaptchaToken: 'x' } }, ctx(u)) as { publicId: string };
    triggerBadgeCheck.mockClear();
    await m.updateProject({}, { id: created.publicId, input: { public: true } }, ctx(u));
    await flush();
    expect(triggerBadgeCheck.mock.calls.map((c) => (c as unknown[])[1])).toContain('project_publish');
  });
});
