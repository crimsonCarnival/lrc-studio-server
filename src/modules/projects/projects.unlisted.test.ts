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
import Activity from '../activity/activity.model.js';
import { createProject, getProject, patchProject } from './projects.crud.service.js';
import { getTrendingProjects } from '../explore/explore.service.js';

let repl: MongoMemoryReplSet;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Project.init(), Lyrics.init(), User.init(), Activity.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), User.deleteMany({}), Activity.deleteMany({})]);
});

let seq = 0;
async function mkUser(): Promise<string> {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({ accountName: `unl${n}`, email: `unl${n}@x.test`, passwordHash: 'x', createdAt: new Date() });
  return insertedId.toString();
}

async function mkProject(owner: string): Promise<string> {
  const res = await createProject({ title: 'Song', lyrics: { editorMode: 'lrc', sections: [{ label: 'V', lines: [{ text: 'a' }] }] } }, owner, '127.0.0.1');
  if (!('publicId' in res)) throw new Error('create failed');
  return res.publicId;
}

const stored = (publicId: string) => Project.findOne({ publicId }).lean();

describe('unlisted visibility', () => {
  it('publishing with listed:false stores an unlisted, public project', async () => {
    const owner = await mkUser();
    const id = await mkProject(owner);
    await patchProject(id, { public: true, listed: false }, owner);
    const p = await stored(id);
    expect(p?.public).toBe(true);
    expect(p?.listed).toBe(false);
  });

  it('a plain publish is listed, and any visibility change resets listed so nothing stays unlisted by accident', async () => {
    const owner = await mkUser();
    const id = await mkProject(owner);
    await patchProject(id, { public: true, listed: false }, owner);
    await patchProject(id, { public: false }, owner);
    await patchProject(id, { public: true }, owner);
    expect((await stored(id))?.listed).toBe(true);
  });

  it('ignores listed:false on a private project', async () => {
    const owner = await mkUser();
    const id = await mkProject(owner);
    await patchProject(id, { listed: false }, owner);
    expect((await stored(id))?.listed).not.toBe(false);
  });

  it('opens by link for anyone, but is not in Explore', async () => {
    const owner = await mkUser();
    const stranger = await mkUser();
    const hidden = await mkProject(owner);
    const shown = await mkProject(owner);
    await patchProject(hidden, { public: true, listed: false }, owner);
    await patchProject(shown, { public: true }, owner);

    expect(await getProject(hidden, stranger)).not.toBeNull();
    expect(await getProject(hidden, null)).not.toBeNull();

    const { projects } = await getTrendingProjects(0, 20);
    const ids = projects.map((p) => p.publicId);
    expect(ids).toContain(shown);
    expect(ids).not.toContain(hidden);
  });

  it('is not announced to followers: no feed activity on publish, and past entries go when it becomes unlisted', async () => {
    const owner = await mkUser();
    const quiet = await mkProject(owner);
    await patchProject(quiet, { public: true, listed: false }, owner);
    // The activity write is fire-and-forget; give it a tick to land if it were going to.
    await new Promise((r) => setTimeout(r, 100));
    expect(await Activity.countDocuments({ publicId: quiet })).toBe(0);

    const loud = await mkProject(owner);
    await patchProject(loud, { public: true }, owner);
    await vi.waitFor(async () => expect(await Activity.countDocuments({ publicId: loud, type: 'project_published' })).toBe(1));
    await patchProject(loud, { public: true, listed: false }, owner);
    await vi.waitFor(async () => expect(await Activity.countDocuments({ publicId: loud })).toBe(0));
  });

  it('announces when an unlisted project is later listed', async () => {
    const owner = await mkUser();
    const id = await mkProject(owner);
    await patchProject(id, { public: true, listed: false }, owner);
    await patchProject(id, { listed: true }, owner);
    await vi.waitFor(async () => expect(await Activity.countDocuments({ publicId: id, type: 'project_published' })).toBe(1));
  });
});
