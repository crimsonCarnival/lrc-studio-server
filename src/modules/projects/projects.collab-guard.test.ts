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
import User from '../users/user.model.js';
import CollabSession from '../collab/collab-session.model.js';
import { createProject, patchProject, updateProject } from './projects.crud.service.js';

// While a collab session is live, the Y.Doc is the source of truth for lyrics
// and song metadata: its next store would silently overwrite a solo save.

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Project.init(), Lyrics.init(), User.init(), CollabSession.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), User.deleteMany({}), CollabSession.deleteMany({})]);
});

async function setup(): Promise<{ userId: string; publicId: string }> {
  const { insertedId } = await User.collection.insertOne({ accountName: 'guard1', email: 'guard1@x.test', passwordHash: 'x' });
  const userId = insertedId.toString();
  const res = await createProject({ title: 'T' }, userId, '127.0.0.1');
  if (!('publicId' in res)) throw new Error('create failed');
  return { userId, publicId: res.publicId as string };
}

const SECTIONS = [{ label: null, id: null, depth: null, timestamp: null, lines: [{ id: 'l1', text: 'solo' }] }];

describe('solo saves during a live collab session', () => {
  it('rejects lyrics and song-metadata writes with collab_active, allows visibility', async () => {
    const { userId, publicId } = await setup();
    await CollabSession.create({ publicId, ownerId: userId });

    for (const input of [{ lyrics: { sections: SECTIONS } }, { metadata: { songName: 'X' } }, { title: 'New' }]) {
      const res = await patchProject(publicId, input, userId);
      expect(res).toMatchObject({ status: 409, code: 'collab_active' });
      const full = await updateProject(publicId, input, userId);
      expect(full).toMatchObject({ status: 409, code: 'collab_active' });
    }
    const visible = await patchProject(publicId, { public: true }, userId);
    expect('error' in visible).toBe(false);
    expect((await Project.findOne({ publicId }).lean())!.title).toBe('T');
  });

  it('a non-owner still gets 403, not a hint that a session exists', async () => {
    const { userId, publicId } = await setup();
    await CollabSession.create({ publicId, ownerId: userId });
    const res = await patchProject(publicId, { lyrics: { sections: SECTIONS } }, new mongoose.Types.ObjectId().toString());
    expect(res).toMatchObject({ status: 403 });
  });

  it('an ended session no longer blocks', async () => {
    const { userId, publicId } = await setup();
    await CollabSession.create({ publicId, ownerId: userId, endedAt: new Date() });
    const res = await patchProject(publicId, { lyrics: { sections: SECTIONS } }, userId);
    expect('error' in res).toBe(false);
  });
});
