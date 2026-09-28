import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));
vi.mock('../badges/badge.service.js', () => ({
  recomputeSyncStats: async () => undefined,
  triggerBadgeCheck: async () => undefined,
  updateStreak: async () => undefined,
}));
vi.mock('../../jobs/leaderboard-ranking.job.js', () => ({ recomputeLeaderboardRanking: async () => undefined }));
vi.mock('../user_logs/logs.service.js', () => ({ logUserAction: () => undefined }));

import Activity from '../../db/activity.model.js';
import HeatmapDay from '../../db/heatmap-day.model.js';
import HeatmapProjectEdit from '../../db/heatmap-project-edit.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import { recordHeatmapEvent, getUserActivityHeatmap } from './activity.service.js';
import { createProject, patchProject } from '../projects/projects.crud.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([HeatmapDay.init(), HeatmapProjectEdit.init(), Project.init(), Lyrics.init(), Activity.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    HeatmapDay.deleteMany({}), HeatmapProjectEdit.deleteMany({}), Activity.deleteMany({}),
    Project.deleteMany({}), Lyrics.deleteMany({}),
  ]);
});

const uid = () => new mongoose.Types.ObjectId().toString();
const today = () => new Date().toISOString().slice(0, 10);
// Fire-and-forget writes: let them land before asserting.
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('recordHeatmapEvent', () => {
  it('counts each distinct project once per UTC day, not once per event', async () => {
    const u = uid();
    const at = new Date('2026-09-20T12:00:00Z');
    for (let i = 0; i < 6; i++) await recordHeatmapEvent(u, 'project_edited', 'projA', at);
    await recordHeatmapEvent(u, 'project_edited', 'projB', at);
    // Same project, later same UTC day — still deduped.
    await recordHeatmapEvent(u, 'project_edited', 'projA', new Date('2026-09-20T23:59:59Z'));
    const docs = await HeatmapDay.find({ userId: u }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ editedProjects: 2, projectsCreated: 0 });
    expect(docs[0].day.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('counts the same project again on a different UTC day', async () => {
    const u = uid();
    await recordHeatmapEvent(u, 'project_edited', 'projA', new Date('2026-09-20T12:00:00Z'));
    await recordHeatmapEvent(u, 'project_edited', 'projA', new Date('2026-09-21T00:00:01Z'));
    const docs = await HeatmapDay.find({ userId: u }).sort({ day: 1 }).lean();
    expect(docs).toHaveLength(2);
    expect(docs.every(d => d.editedProjects === 1)).toBe(true);
  });

  it('creating then editing the same project on the same day counts once total, not twice', async () => {
    const u = uid();
    const at = new Date('2026-09-20T12:00:00Z');
    await recordHeatmapEvent(u, 'project_created', 'projA', at);
    await recordHeatmapEvent(u, 'project_edited', 'projA', at);
    const doc = await HeatmapDay.findOne({ userId: u }).lean();
    expect(doc).toMatchObject({ projectsCreated: 1, editedProjects: 0 });
  });

  it('survives concurrent first writes for the same (user, project, day)', async () => {
    const u = uid();
    await Promise.all(Array.from({ length: 5 }, () => recordHeatmapEvent(u, 'project_edited', 'projA')));
    const doc = await HeatmapDay.findOne({ userId: u }).lean();
    expect(doc?.editedProjects).toBe(1);
  });

  it('survives concurrent first writes for distinct projects on the same day', async () => {
    const u = uid();
    await Promise.all(Array.from({ length: 5 }, (_, i) => recordHeatmapEvent(u, 'project_created', `proj${i}`)));
    const doc = await HeatmapDay.findOne({ userId: u }).lean();
    expect(doc?.projectsCreated).toBe(5);
  });
});

describe('getUserActivityHeatmap', () => {
  it('merges social activities and private counters per day, within the window', async () => {
    const u = uid();
    await Activity.create({ actorId: u, type: 'project_published', publicId: 'p' });
    await recordHeatmapEvent(u, 'project_created', 'projA');
    await recordHeatmapEvent(u, 'project_edited', 'projB');
    await HeatmapDay.collection.insertOne({
      userId: new mongoose.Types.ObjectId(u), day: new Date(Date.now() - 400 * 86400000), projectsCreated: 3, editedProjects: 0,
    });
    const days = await getUserActivityHeatmap(u);
    expect(days).toEqual([{ date: today(), count: 3 }]);
  });

  it('never writes private events into the social activities collection', async () => {
    const u = uid();
    await recordHeatmapEvent(u, 'project_created', 'projA');
    expect(await Activity.countDocuments({ actorId: u })).toBe(0);
  });
});

describe('project hooks', () => {
  async function mkProject(u: string): Promise<string> {
    const res = await createProject({
      title: 'T', lyrics: { editorMode: 'lrc', sections: [{ lines: [{ text: 'a', timestamp: 1 }] }] },
    }, u, '127.0.0.1');
    if (!('publicId' in res)) throw new Error('create failed');
    await settle();
    return res.publicId as string;
  }
  const counters = async (u: string) => HeatmapDay.findOne({ userId: u }).lean();
  // Project creation and these edits happen "on the same day" in real test time,
  // so creation already claims that project's dedup row for today (see the
  // "counts once total" behavior above). Clearing it isolates the edit-detection
  // assertions below from that same-day collision — equivalent to testing edits
  // on a later day than creation.
  const clearDedup = (u: string) => HeatmapProjectEdit.deleteMany({ userId: u });

  it('counts project creation', async () => {
    const u = uid();
    await mkProject(u);
    expect((await counters(u))?.projectsCreated).toBe(1);
  });

  it('ignores saves — manual or auto — that change nothing or only playback state / visibility', async () => {
    const u = uid();
    const id = await mkProject(u);
    await clearDedup(u);
    await patchProject(id, { title: 'T' }, u);
    await patchProject(id, { saveKind: 'manual', title: 'T' }, u);
    await patchProject(id, { state: { playbackPosition: 42 } }, u);
    await patchProject(id, { saveKind: 'manual', public: false }, u);
    await patchProject(id, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: 1 } } }, u);
    await patchProject(id, { saveKind: 'manual', lyrics: { sections: [{ lines: [{ text: 'a', timestamp: 1 }] }] } }, u);
    await settle();
    expect((await counters(u))?.editedProjects ?? 0).toBe(0);
  });

  it('counts an autosave (no saveKind) that changes content, same as a manual save', async () => {
    const u = uid();
    const id = await mkProject(u);
    await clearDedup(u);
    await patchProject(id, { title: 'Changed by autosave' }, u);
    await settle();
    expect((await counters(u))?.editedProjects).toBe(1);
  });

  it('counts one project once per day no matter how many times it is saved (manual and/or auto)', async () => {
    const u = uid();
    const id = await mkProject(u);
    await clearDedup(u);
    await patchProject(id, { saveKind: 'manual', title: 'New' }, u);
    await patchProject(id, { metadata: { songName: 'S' } }, u);
    await patchProject(id, { saveKind: 'manual', lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: 2 } } }, u);
    await settle();
    expect((await counters(u))?.editedProjects).toBe(1);
  });

  it('counts distinct projects edited the same day separately', async () => {
    const u = uid();
    const id1 = await mkProject(u);
    const id2 = await mkProject(u);
    await clearDedup(u);
    await patchProject(id1, { title: 'A changed' }, u);
    await patchProject(id2, { title: 'B changed' }, u);
    await settle();
    expect((await counters(u))?.editedProjects).toBe(2);
  });
});
