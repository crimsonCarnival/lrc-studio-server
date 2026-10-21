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
vi.mock('../user_logs/logs.service.js', () => ({ logUserAction: () => undefined }));

import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import User from '../../db/user.model.js';
import { createProject, patchProject } from './projects.crud.service.js';

// Covers the `lines` array shape added to the positional lyrics patch:
// several changed lines in one save, written as one findOneAndUpdate with
// one dotted $set path per line, instead of falling back to a full
// `sections` replace. A round-trip through the real write path, not a unit
// test of the dotted-path string building, because the thing actually worth
// verifying is that sectionIdx/lineIdx addressing survives the trip and
// leaves every untouched line exactly as it was.

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
    accountName: `linespatch${n}`, email: `linespatch${n}@x.test`, passwordHash: 'x',
  });
  return insertedId.toString();
}

async function mkProject(userId: string): Promise<string> {
  const res = await createProject({
    title: 'T',
    lyrics: {
      editorMode: 'lrc',
      sections: [
        { label: 'Verse', lines: [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: 2 }] },
        { label: 'Chorus', lines: [{ text: 'c', timestamp: 3 }, { text: 'd', timestamp: 4 }] },
      ],
    },
  }, userId, '127.0.0.1');
  if (!('publicId' in res)) throw new Error('create failed');
  return res.publicId as string;
}

async function getSections(publicId: string) {
  const doc = await Lyrics.findOne({ publicId }).lean<{ sections?: Array<{ label?: string; lines: Array<{ text?: string; timestamp?: number }> }> }>();
  return doc!.sections!;
}

describe('patchProject — lines array patch', () => {
  it('writes every entry to its own sectionIdx/lineIdx, leaving other lines untouched', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);

    const result = await patchProject(id, {
      lyrics: {
        lines: [
          { sectionIdx: 0, lineIdx: 1, line: { text: 'B', timestamp: 2.5 } },
          { sectionIdx: 1, lineIdx: 0, line: { text: 'C', timestamp: 3.5 } },
        ],
      },
    }, u);
    expect('error' in result).toBe(false);

    const sections = await getSections(id);
    expect(sections[0].lines[0]).toMatchObject({ text: 'a', timestamp: 1 }); // untouched
    expect(sections[0].lines[1]).toMatchObject({ text: 'B', timestamp: 2.5 }); // patched
    expect(sections[1].lines[0]).toMatchObject({ text: 'C', timestamp: 3.5 }); // patched
    expect(sections[1].lines[1]).toMatchObject({ text: 'd', timestamp: 4 }); // untouched
    // Section-level fields (label) must survive a lines-array patch exactly
    // as they do for the single-line patch — only line paths are $set.
    expect(sections[0].label).toBe('Verse');
    expect(sections[1].label).toBe('Chorus');
  });

  it('bumps the lyrics version exactly once per save, not once per line', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);
    const before = await Lyrics.findOne({ publicId: id }).lean<{ version?: number }>();

    await patchProject(id, {
      lyrics: {
        lines: [
          { sectionIdx: 0, lineIdx: 0, line: { text: 'A' } },
          { sectionIdx: 0, lineIdx: 1, line: { text: 'B' } },
          { sectionIdx: 1, lineIdx: 0, line: { text: 'C' } },
        ],
      },
    }, u);

    const after = await Lyrics.findOne({ publicId: id }).lean<{ version?: number }>();
    expect(after!.version).toBe((before!.version ?? 0) + 1);
  });

  it('rejects an out-of-range sectionIdx rather than silently creating sparse sections', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);

    await expect(patchProject(id, {
      lyrics: { lines: [{ sectionIdx: -1, lineIdx: 0, line: { text: 'x' } }] },
    }, u)).rejects.toThrow();
  });

  it('rejects an empty lines array rather than treating it as a no-op', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);

    await expect(patchProject(id, {
      lyrics: { lines: [] },
    }, u)).rejects.toThrow();
  });

  it('ignores fields outside the line-field whitelist (no type/label smuggled through a line patch)', async () => {
    const u = await mkOwner();
    const id = await mkProject(u);

    await patchProject(id, {
      lyrics: {
        lines: [
          { sectionIdx: 0, lineIdx: 0, line: { text: 'A', type: 'section', label: 'smuggled' } as unknown as { text: string } },
        ],
      },
    }, u);

    const sections = await getSections(id);
    expect(sections[0].lines[0].text).toBe('A');
    expect((sections[0].lines[0] as unknown as { type?: string }).type).toBeUndefined();
    expect(sections[0].label).toBe('Verse'); // section's own label untouched
  });
});
