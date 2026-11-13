import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));
vi.mock('../user-logs/logs.service.js', () => ({ logUserAction: () => undefined }));
vi.mock('../../lib/job-queue.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), scheduleOnce: async () => undefined }));

import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Notification from '../notifications/notification.model.js';
import { patchProject, updateProject } from './projects.crud.service.js';
import { isPublishable } from './publish-readiness.js';

let repl: MongoMemoryReplSet;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Project.init(), Lyrics.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), Notification.deleteMany({})]);
});

type L = { text: string; timestamp?: number | null; words?: { word: string; time: number | null }[]; type?: string };
const owner = new mongoose.Types.ObjectId();
const uid = owner.toString();

async function seed(publicId: string, lines: L[], title = 'Song') {
  await Project.collection.insertOne({ publicId, title, slug: 'song', public: false, listed: true, userId: owner, createdAt: new Date(), updatedAt: new Date() });
  await Lyrics.collection.insertOne({ publicId, editorMode: 'lrc', sections: [{ label: '', timestamp: null, lines }] });
}
const isPublic = async (id: string) => !!(await Project.collection.findOne({ publicId: id }))?.public;
const codeOf = (r: unknown) => (r as { code?: string }).code;

describe('isPublishable', () => {
  it('needs a title and every lyric line timed; markers and word times follow the shared rule', () => {
    const s = (lines: L[]) => [{ lines }];
    expect(isPublishable('T', s([{ text: 'a', timestamp: 0 }, { text: '', type: 'section' }]))).toBe(true);
    expect(isPublishable('T', s([{ text: 'a', words: [{ word: 'a', time: 1 }] }]))).toBe(true);
    expect(isPublishable('T', s([{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: null }]))).toBe(false);
    expect(isPublishable('T', s([]))).toBe(false);
    expect(isPublishable('   ', s([{ text: 'a', timestamp: 1 }]))).toBe(false);
  });
});

describe('publish gate', () => {
  it('refuses publishing (listed or unlisted) a project with an untimed line', async () => {
    await seed('partial0001', [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: null }]);
    expect(codeOf(await patchProject('partial0001', { public: true }, uid))).toBe('project_incomplete');
    expect(codeOf(await patchProject('partial0001', { public: true, listed: false }, uid))).toBe('project_incomplete');
    expect(codeOf(await updateProject('partial0001', { public: true }, uid))).toBe('project_incomplete');
    expect(await isPublic('partial0001')).toBe(false);
  });

  it('publishes a finished project', async () => {
    await seed('full0000001', [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: 2 }]);
    const res = await patchProject('full0000001', { public: true }, uid);
    expect('error' in res).toBe(false);
    expect(await isPublic('full0000001')).toBe(true);
  });

  it('judges full sections sent in the same request, not the stored ones', async () => {
    await seed('sameReq0001', [{ text: 'a', timestamp: null }]);
    const res = await patchProject('sameReq0001', { public: true, lyrics: { sections: [{ label: '', timestamp: null, lines: [{ text: 'a', timestamp: 3 }] }] } }, uid);
    expect('error' in res).toBe(false);
    expect(await isPublic('sameReq0001')).toBe(true);
  });

  it('refuses a positional lyrics patch combined with publish', async () => {
    await seed('position001', [{ text: 'a', timestamp: 1 }]);
    const res = await patchProject('position001', { public: true, lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: null } } }, uid);
    expect(codeOf(res)).toBe('publish_with_partial_lyrics');
    expect(await isPublic('position001')).toBe(false);
  });

  it('unpublishes a public project saved into an unfinished state, and notifies the owner once', async () => {
    await seed('drift000001', [{ text: 'a', timestamp: 1 }]);
    await Project.collection.updateOne({ publicId: 'drift000001' }, { $set: { public: true } });
    const untimed = { sections: [{ label: '', timestamp: null, lines: [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: null }] }] };
    const res = await patchProject('drift000001', { lyrics: untimed }, uid) as { project: { public?: boolean }; autoUnpublished?: boolean };
    expect(res.autoUnpublished).toBe(true);
    expect(res.project.public).toBe(false);
    expect(await isPublic('drift000001')).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(await Notification.countDocuments({ userId: owner, 'meta.kind': 'projects_privatized' })).toBe(1);
  });

  it('keeps a public project public when the save leaves it finished, or does not touch lyrics/title', async () => {
    await seed('stays000001', [{ text: 'a', timestamp: null }]);
    await Project.collection.updateOne({ publicId: 'stays000001' }, { $set: { public: true } });
    // Legacy unfinished public row: an unrelated save (state only) does not flip it.
    await patchProject('stays000001', { state: { activeLineIndex: 0 } }, uid);
    expect(await isPublic('stays000001')).toBe(true);
    const timed = { sections: [{ label: '', timestamp: null, lines: [{ text: 'a', timestamp: 2 }] }] };
    const res = await patchProject('stays000001', { lyrics: timed }, uid) as { autoUnpublished?: boolean };
    expect(res.autoUnpublished).toBe(false);
    expect(await isPublic('stays000001')).toBe(true);
  });

  it('does not block unpublishing or ordinary edits', async () => {
    await seed('editOnly001', [{ text: 'a', timestamp: null }]);
    expect('error' in await patchProject('editOnly001', { title: 'New' }, uid)).toBe(false);
    await Project.collection.updateOne({ publicId: 'editOnly001' }, { $set: { public: true } });
    expect('error' in await patchProject('editOnly001', { public: false }, uid)).toBe(false);
  });
});
