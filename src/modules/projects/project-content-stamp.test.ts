import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));
vi.mock('../badges/badge.service.js', () => ({
  recomputeSyncStats: async () => undefined,
  scheduleSyncStatsRefresh: () => undefined,
  triggerBadgeCheck: async () => undefined,
  updateStreak: async () => undefined,
}));
vi.mock('../../jobs/leaderboard-ranking.job.js', () => ({ recomputeLeaderboardRanking: async () => undefined }));
vi.mock('../user-logs/logs.service.js', () => ({ logUserAction: () => undefined }));

import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import User from '../../db/user.model.js';
import { createProject, patchProject } from './projects.crud.service.js';

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
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), User.deleteMany({})]);
});

let ownerSeq = 0;
async function mkOwner(): Promise<string> {
  const n = ++ownerSeq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `stampowner${n}`, email: `stampowner${n}@x.test`, passwordHash: 'x',
  });
  return insertedId.toString();
}

async function mkProject(userId: string): Promise<string> {
  const res = await createProject({
    title: 'T', lyrics: { editorMode: 'lrc', sections: [{ lines: [{ text: 'a', timestamp: 1 }] }] },
  }, userId, '127.0.0.1');
  if (!('publicId' in res)) throw new Error('create failed');
  return res.publicId as string;
}

const stamps = async (publicId: string) => {
  const p = await Project.findOne({ publicId }).lean<{ updatedAt?: Date; contentUpdatedAt?: Date }>();
  return { updatedAt: p?.updatedAt?.getTime(), contentUpdatedAt: p?.contentUpdatedAt?.getTime() };
};

// `updatedAt` is a write stamp; `contentUpdatedAt` is what the UI shows as
// "edited ...". The two must come apart exactly where a save is not an edit.
describe('contentUpdatedAt', () => {
  it('is set when the project is created', async () => {
    const id = await mkProject(await mkOwner());
    const { contentUpdatedAt, updatedAt } = await stamps(id);
    expect(contentUpdatedAt).toBeDefined();
    expect(updatedAt).toBeDefined();
  });

  it('does not move for an editor-state save, though updatedAt does', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);
    const before = await stamps(id);

    await patchProject(id, { state: { playbackPosition: 42 } }, u);

    const after = await stamps(id);
    expect(after.contentUpdatedAt).toBe(before.contentUpdatedAt);
    expect(after.updatedAt!).toBeGreaterThanOrEqual(before.updatedAt!);
  });

  it('does not move for a visibility toggle or a re-sent identical title', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);
    const before = await stamps(id);

    await patchProject(id, { public: true }, u);
    await patchProject(id, { title: 'T' }, u);

    expect((await stamps(id)).contentUpdatedAt).toBe(before.contentUpdatedAt);
  });

  it('moves when the title actually changes', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);
    const before = await stamps(id);

    await patchProject(id, { title: 'Different' }, u);

    expect((await stamps(id)).contentUpdatedAt!).toBeGreaterThan(before.contentUpdatedAt!);
  });

  it('moves when the lyrics are patched', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);
    const before = await stamps(id);

    await patchProject(id, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'b', timestamp: 2 } } }, u);

    expect((await stamps(id)).contentUpdatedAt!).toBeGreaterThan(before.contentUpdatedAt!);
  });

  it('is left alone by counter writes (view, star, share)', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);
    const before = await stamps(id);

    await Project.updateOne({ publicId: id }, { $inc: { viewCount: 1, starCount: 1 } }, { timestamps: false });

    const after = await stamps(id);
    expect(after.contentUpdatedAt).toBe(before.contentUpdatedAt);
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});
