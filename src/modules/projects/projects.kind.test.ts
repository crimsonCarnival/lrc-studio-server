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
import { createProject, listProjects } from './projects.crud.service.js';
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
  const { insertedId } = await User.collection.insertOne({ accountName: `kind${n}`, email: `kind${n}@x.test`, passwordHash: 'x', createdAt: new Date() });
  return insertedId.toString();
}

const sections = [{ label: 'V', lines: [{ text: 'a' }] }];

async function create(userId: string, input: Record<string, unknown>): Promise<string> {
  const res = await createProject({ title: 'P', lyrics: { sections }, ...input }, userId, '127.0.0.1');
  if (!('publicId' in res)) throw new Error(`create failed: ${JSON.stringify(res)}`);
  return res.publicId;
}

describe('project kind', () => {
  it('is a song unless the create asks for subtitles', async () => {
    const u = await mkUser();
    const plain = await create(u, {});
    const junk = await create(u, { kind: 'podcast' });
    expect((await Project.findOne({ publicId: plain }).lean())?.kind).toBe('song');
    expect((await Project.findOne({ publicId: junk }).lean())?.kind).toBe('song');
  });

  it('stores subtitles and starts its lyrics in srt mode', async () => {
    const u = await mkUser();
    const id = await create(u, { kind: 'subtitles' });
    expect((await Project.findOne({ publicId: id }).lean())?.kind).toBe('subtitles');
    expect((await Lyrics.findOne({ publicId: id }).lean())?.editorMode).toBe('srt');
  });

  it('keeps an explicit editor mode for a subtitle project', async () => {
    const u = await mkUser();
    const id = await create(u, { kind: 'subtitles', lyrics: { editorMode: 'lrc', sections } });
    expect((await Lyrics.findOne({ publicId: id }).lean())?.editorMode).toBe('lrc');
  });

  it('is listed, with rows from before the field reading as songs', async () => {
    const u = await mkUser();
    const sub = await create(u, { kind: 'subtitles' });
    const legacy = await create(u, {});
    await Project.collection.updateOne({ publicId: legacy }, { $unset: { kind: '' } });
    const kinds = Object.fromEntries((await listProjects(u)).map((p) => [p.publicId, p.kind]));
    expect(kinds).toEqual({ [sub]: 'subtitles', [legacy]: 'song' });
  });

  it('survives a fork', async () => {
    const owner = await mkUser();
    const forker = await mkUser();
    const id = await create(owner, { kind: 'subtitles' });
    await Project.updateOne({ publicId: id }, { $set: { public: true } });
    const forked = await cloneProject(id, forker);
    if (!('publicId' in forked)) throw new Error(`fork failed: ${JSON.stringify(forked)}`);
    expect((await Project.findOne({ publicId: forked.publicId }).lean())?.kind).toBe('subtitles');
  });
});
