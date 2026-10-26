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
import { createProject, patchProject } from './projects.crud.service.js';

// patchProject's version check used to be read-then-compare ahead of the
// transaction, with the actual write unconditioned on version — two
// concurrent patches against the same stale version could both pass the
// check and both write, the second clobbering the first. The fix folds the
// precondition into the update's own filter. No live client sends `version`
// yet (confirmed in client/src/features/editor/hooks/useManualSave.ts), so
// this only covers the mechanism for whenever one does — it is not yet
// exercised by any real traffic.

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
    accountName: `verconf${n}`, email: `verconf${n}@x.test`, passwordHash: 'x',
  });
  return insertedId.toString();
}

// `version` defaults to 0 on project.model.ts (see that file for why this
// needed fixing there too — the field didn't exist at all until this change,
// so every $inc at every call site in projects.crud.service.ts was silently
// stripped under the schema's default strict mode and never persisted).
// The GraphQL `Project` output type still doesn't expose it (only
// UpdateProjectInput has it, write-only) — no live client can read it back
// to know what to send, which is why this whole mechanism remains opt-in.
async function mkProject(userId: string): Promise<{ id: string; version: number }> {
  const res = await createProject({ title: 'T' }, userId, '127.0.0.1');
  if (!('publicId' in res)) throw new Error('create failed');
  const id = res.publicId as string;
  const doc = await Project.findOne({ publicId: id }).lean<{ version: number }>();
  return { id, version: doc!.version };
}

describe('patchProject — version conflict', () => {
  it('a patch with no version is unaffected (current, real-world behavior)', async () => {
    const u = await mkOwner();
    const { id } = await mkProject(u);
    const result = await patchProject(id, { title: 'New title' }, u);
    expect('error' in result).toBe(false);
  });

  it('a patch with the current version succeeds and bumps it', async () => {
    const u = await mkOwner();
    const { id, version } = await mkProject(u);
    const result = await patchProject(id, { title: 'New title', version }, u);
    expect('error' in result).toBe(false);
    const after = await Project.findOne({ publicId: id }).lean<{ version: number }>();
    expect(after!.version).toBe(version + 1);
  });

  it('a patch with a stale version is rejected with 409, and nothing is written', async () => {
    const u = await mkOwner();
    const { id, version } = await mkProject(u);
    await patchProject(id, { title: 'First save' }, u); // bumps version, no conflict check (no version sent)

    const result = await patchProject(id, { title: 'Stale save' }, u); // still no version — control case
    expect('error' in result).toBe(false); // confirms the control path is unaffected

    const stale = await patchProject(id, { title: 'Conflicting save', version }, u); // the original, now-stale version
    expect(stale).toMatchObject({ error: 'Version conflict — reload and retry', status: 409 });

    const project = await Project.findOne({ publicId: id }).lean<{ title: string }>();
    expect(project!.title).toBe('Stale save'); // the rejected patch did not land
  });

  it('two concurrent patches against the same version: exactly one succeeds', async () => {
    const u = await mkOwner();
    const { id, version } = await mkProject(u);

    const [a, b] = await Promise.all([
      patchProject(id, { title: 'A', version }, u),
      patchProject(id, { title: 'B', version }, u),
    ]);
    const results = [a, b];
    const succeeded = results.filter((r) => !('error' in r));
    const conflicted = results.filter((r) => 'error' in r);
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0]).toMatchObject({ status: 409 });

    const after = await Project.findOne({ publicId: id }).lean<{ version: number; title: string }>();
    expect(after!.version).toBe(version + 1); // not +2 — the conflicting write never happened
    expect(['A', 'B']).toContain(after!.title);
  });

  it('a lyrics-only patch (no project-level fields) is still gated by a provided version', async () => {
    const u = await mkOwner();
    const { id, version } = await mkProject(u);
    await patchProject(id, { title: 'bump' }, u); // moves the version with no conflict check

    const stale = await patchProject(id, {
      version, // now stale
      lyrics: { sections: [{ lines: [{ text: 'x', timestamp: 1 }] }] },
    }, u);
    expect(stale).toMatchObject({ status: 409 });

    const lyrics = await Lyrics.findOne({ publicId: id }).lean<{ sections?: unknown[] }>();
    expect(lyrics?.sections?.length ?? 0).toBe(0); // the rejected lyrics patch did not land
  });
});
