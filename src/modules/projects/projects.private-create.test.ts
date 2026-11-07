import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));
vi.mock('../user-logs/logs.service.js', () => ({ logUserAction: () => undefined }));
vi.mock('../../lib/job-queue.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), scheduleOnce: async () => undefined }));

import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import User from '../users/user.model.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { createProject } from './projects.crud.service.js';
import { cloneProject } from './projects.sharing.service.js';

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
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), User.deleteMany({}), UserPreferences.deleteMany({})]);
});

let seq = 0;
async function mkUser(): Promise<string> {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({ accountName: `priv${n}`, email: `priv${n}@x.test`, passwordHash: 'x', createdAt: new Date() });
  return insertedId.toString();
}

describe('every new project is private', () => {
  it('createProject ignores public:true input and stored preference', async () => {
    const u = await mkUser();
    // A legacy preference document that still carries the removed field.
    await UserPreferences.collection.insertOne({ userId: new mongoose.Types.ObjectId(u), defaultProjectPrivacy: 'public' });
    const res = await createProject({ title: 'Mine', public: true, lyrics: { editorMode: 'lrc', sections: [{ label: 'V', lines: [{ text: 'a' }] }] } }, u, '127.0.0.1');
    if (!('publicId' in res)) throw new Error('create failed');
    const stored = await Project.findOne({ publicId: res.publicId }).lean();
    expect(stored?.public).toBe(false);
  });

  // Regression guard: forks already defaulted to private via the model; keep it explicit.
  it('a fork of a public project is private', async () => {
    const owner = await mkUser();
    const forker = await mkUser();
    const res = await createProject({ title: 'Src', lyrics: { editorMode: 'lrc', sections: [{ label: 'V', lines: [{ text: 'a' }] }] } }, owner, '127.0.0.1');
    if (!('publicId' in res)) throw new Error('create failed');
    await Project.updateOne({ publicId: res.publicId }, { $set: { public: true } });
    const forked = await cloneProject(res.publicId, forker);
    if (!('publicId' in forked)) throw new Error(`fork failed: ${JSON.stringify(forked)}`);
    expect((await Project.findOne({ publicId: forked.publicId }).lean())?.public).toBe(false);
  });
});
