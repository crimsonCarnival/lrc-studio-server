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
import BadgeDefinition from '../badges/badge-definition.model.js';
import { createProject, patchProject, deleteProject } from './projects.crud.service.js';
import { projectResolvers } from '../../graphql/resolvers/project.resolvers.js';
import { grantBadge, createBadgeDef, updateBadgeDef, updateStreak, runSyncStatsRefresh, retireBuiltinBadges, MAX_BADGE_XP_REWARD } from '../badges/badge.service.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { getAddictionTitles } from '../stats/content-stats.service.js';
import { MAX_TIME_SECONDS } from '../lyrics/lyrics.model.js';

// Guards added after the gamification audit: each one closes a way to farm XP, badges or a
// streak. Round-trips through the real write paths against an in-memory replica set.

type Resolver = (root: unknown, args: Record<string, unknown>, context: unknown) => Promise<unknown>;
const m = projectResolvers.Mutation as unknown as Record<string, Resolver>;
const ctx = (userId: string) => ({ userId, ip: '127.0.0.1' });
// withTransaction reports a failure inside the callback as TransactionError('transaction_rollback')
// and keeps the real error on `.cause`.
const causeMessage = (re: RegExp) => ({ cause: { message: expect.stringMatching(re) } });
const settle = () => new Promise((r) => setTimeout(r, 300));

let repl: MongoMemoryReplSet;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Project.init(), Lyrics.init(), User.init(), BadgeDefinition.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), User.deleteMany({}), Activity.deleteMany({}), BadgeDefinition.deleteMany({}), UserPreferences.deleteMany({})]);
});

let seq = 0;
async function mkUser(extra: Record<string, unknown> = {}): Promise<string> {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({ accountName: `guard${n}`, email: `guard${n}@x.test`, passwordHash: 'x', createdAt: new Date(), ...extra });
  return insertedId.toString();
}
async function mkProject(userId: string, lines: unknown[] = [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: 2 }], pub = true): Promise<string> {
  const res = await createProject({ title: `T${++seq}`, lyrics: { editorMode: 'lrc', sections: [{ label: 'V', lines }] } }, userId, '127.0.0.1');
  if (!('publicId' in res)) throw new Error('create failed');
  // Creation is always private; publish directly for tests that need a public project.
  if (pub) await Project.updateOne({ publicId: res.publicId }, { $set: { public: true } });
  return res.publicId as string;
}
const dayAgo = () => new Date(Date.now() - 86400000);

describe('timing range guard', () => {
  it('rejects an out-of-range timestamp on every lyrics write shape', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    const bad = MAX_TIME_SECONDS + 1;
    await expect(patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: bad } } }, u)).rejects.toMatchObject(causeMessage(/time must be between/));
    await expect(patchProject(p, { lyrics: { lines: [{ sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: bad } }] } }, u)).rejects.toMatchObject(causeMessage(/time must be between/));
    await expect(patchProject(p, { lyrics: { sections: [{ label: 'V', lines: [{ text: 'a', timestamp: bad }] }] } }, u)).rejects.toMatchObject(causeMessage(/time must be between/));
    await expect(patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, wordIndex: 0, word: { word: 'a', time: bad } } }, u)).rejects.toMatchObject(causeMessage(/time must be between/));
    await expect(patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: -1 } } }, u)).rejects.toMatchObject(causeMessage(/time must be between/));
  });

  it('rejects an out-of-range timestamp at creation', async () => {
    const u = await mkUser();
    await expect(mkProject(u, [{ text: 'a', timestamp: 1e300 }])).rejects.toThrow();
  });

  it('accepts the boundary value', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    await patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: MAX_TIME_SECONDS } } }, u);
    const doc = await Lyrics.findOne({ publicId: p }).lean<{ sections: Array<{ lines: Array<{ timestamp: number }> }> }>();
    expect(doc!.sections[0].lines[0].timestamp).toBe(MAX_TIME_SECONDS);
  });
});

describe('line source', () => {
  it('persists source through positional patches and rejects unknown values', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    await patchProject(p, { lyrics: { lines: [
      { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: 1, source: 'asr' } },
      { sectionIdx: 0, lineIdx: 1, line: { text: 'b', timestamp: 2, source: 'asr' } },
    ] } }, u);
    const doc = await Lyrics.findOne({ publicId: p }).lean<{ sections: Array<{ lines: Array<{ source?: string }> }> }>();
    expect(doc!.sections[0].lines.map((l) => l.source)).toEqual(['asr', 'asr']);

    await patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: 9, source: 'manual' } } }, u);
    const after = await Lyrics.findOne({ publicId: p }).lean<{ sections: Array<{ lines: Array<{ source?: string }> }> }>();
    expect(after!.sections[0].lines[0].source).toBe('manual');

    await expect(patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', source: 'hacked' } } }, u)).rejects.toMatchObject(causeMessage(/invalid source/));
  });
});

describe('streak', () => {
  it('is not extended by a no-op lyrics patch', async () => {
    const u = await mkUser({ streak: { current: 5, longest: 5, lastActiveDate: dayAgo() } });
    const p = await mkProject(u);
    await settle();
    await User.updateOne({ _id: u }, { 'streak.current': 5, 'streak.lastActiveDate': dayAgo() });
    await patchProject(p, { lyrics: {} }, u);
    await settle();
    const doc = await User.findById(u).lean<{ streak: { current: number } }>();
    expect(doc!.streak.current).toBe(5);
  });

  it('is extended by a real lyrics change', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    await settle();
    await User.updateOne({ _id: u }, { 'streak.current': 5, 'streak.lastActiveDate': dayAgo() });
    await patchProject(p, { lyrics: { sectionIdx: 0, lineIdx: 0, line: { text: 'a', timestamp: 7 } } }, u);
    await settle();
    const doc = await User.findById(u).lean<{ streak: { current: number } }>();
    expect(doc!.streak.current).toBe(6);
  });

  it('is not extended by forking', async () => {
    const owner = await mkUser();
    const forker = await mkUser({ streak: { current: 5, longest: 5, lastActiveDate: dayAgo() } });
    const src = await mkProject(owner);
    await m.cloneProject(null, { id: src }, ctx(forker));
    await settle();
    const doc = await User.findById(forker).lean<{ streak: { current: number } }>();
    expect(doc!.streak.current).toBe(5);
  });
});

describe('star counters', () => {
  it('gives no owner credit for a self-star and nets zero on repeat cycles', async () => {
    const u = await mkUser();
    const p = await mkProject(u);
    for (let i = 0; i < 3; i++) {
      await m.starProject(null, { id: p }, ctx(u));
      await m.unstarProject(null, { id: p }, ctx(u));
    }
    await settle();
    const doc = await User.findById(u).lean<{ social?: { totalStarsReceived?: number } }>();
    expect(doc!.social?.totalStarsReceived ?? 0).toBe(0);
    expect(await Activity.countDocuments({ type: 'project_starred' })).toBe(0);
  });

  it('credits another user once and takes it back on unstar', async () => {
    const owner = await mkUser();
    const fan = await mkUser();
    const p = await mkProject(owner);
    await m.starProject(null, { id: p }, ctx(fan));
    await settle();
    expect((await User.findById(owner).lean<{ social: { totalStarsReceived: number } }>())!.social.totalStarsReceived).toBe(1);
    await m.unstarProject(null, { id: p }, ctx(fan));
    expect((await User.findById(owner).lean<{ social: { totalStarsReceived: number } }>())!.social.totalStarsReceived).toBe(0);
  });
});

describe('fork counters', () => {
  it('takes the owner credit back when the fork is deleted', async () => {
    const owner = await mkUser();
    const alt = await mkUser();
    const src = await mkProject(owner);
    for (let i = 0; i < 3; i++) {
      const c = await m.cloneProject(null, { id: src }, ctx(alt)) as { publicId: string };
      await settle();
      await deleteProject(c.publicId, alt);
    }
    const doc = await User.findById(owner).lean<{ social: { totalForksReceived: number } }>();
    expect(doc!.social.totalForksReceived).toBe(0);
  });

  it('does not count a self-fork toward forkCount', async () => {
    const owner = await mkUser();
    const src = await mkProject(owner);
    await m.cloneProject(null, { id: src }, ctx(owner));
    const proj = await Project.findOne({ publicId: src }).lean<{ forkCount?: number }>();
    expect(proj!.forkCount ?? 0).toBe(0);
  });
});

describe('publish activity', () => {
  it('is written once however often visibility is toggled', async () => {
    const u = await mkUser();
    const p = await mkProject(u, [{ text: 'a', timestamp: 1 }], false);
    for (let i = 0; i < 3; i++) {
      await patchProject(p, { public: true }, u);
      await settle();
      await patchProject(p, { public: false }, u);
    }
    await settle();
    expect(await Activity.countDocuments({ type: 'project_published' })).toBe(1);
  });
});

describe('badge definitions', () => {
  it('refuses to grant an id with no definition', async () => {
    const u = await mkUser();
    expect(await grantBadge(u, 'ghost-badge')).toBe(false);
    const doc = await User.findById(u).lean<{ badges?: unknown[] }>();
    expect(doc!.badges ?? []).toHaveLength(0);
  });

  it('rejects an xpReward above the cap on create and update', async () => {
    await expect(createBadgeDef({ id: 'big', label: { en: 'Big' }, color: 'amber', conditionType: 'manual', xpReward: MAX_BADGE_XP_REWARD + 1 })).rejects.toThrow(/xpReward/);
    await createBadgeDef({ id: 'ok', label: { en: 'Ok' }, color: 'amber', conditionType: 'manual', xpReward: MAX_BADGE_XP_REWARD });
    await expect(updateBadgeDef('ok', { xpReward: -5 })).rejects.toThrow(/xpReward/);
  });
});

describe('streak days follow the user timezone', () => {
  it('extends an evening streak that UTC days would have reset', async () => {
    // Bogota (UTC-5): last active Tue 18:30 local, working again Wed 20:00 local (Thu 01:00Z).
    const u = await mkUser({ streak: { current: 3, longest: 3, lastActiveDate: new Date('2026-09-22T23:30:00Z'), timezone: 'America/Bogota' } });
    expect(await updateStreak(u, new Date('2026-09-24T01:00:00Z'))).toBe(4);
  });

  it('resets the same history for a user with no timezone (UTC)', async () => {
    const u = await mkUser({ streak: { current: 3, longest: 3, lastActiveDate: new Date('2026-09-22T23:30:00Z') } });
    expect(await updateStreak(u, new Date('2026-09-24T01:00:00Z'))).toBe(1);
  });
});

describe('sync stats feed XP', () => {
  it('moves XP when stats refresh, and gives a fork nothing until its lines are re-timed', async () => {
    const owner = await mkUser();
    const forker = await mkUser();
    const src = await mkProject(owner, Array.from({ length: 10 }, (_, i) => ({ text: `l${i}`, timestamp: (i + 1) * 60 })));
    const forked = await m.cloneProject(null, { id: src }, ctx(forker)) as { publicId: string };
    await settle();

    const lyrics = await Lyrics.findOne({ publicId: forked.publicId }).lean<{ sections: Array<{ lines: Array<{ source?: string }> }> }>();
    expect(lyrics!.sections[0].lines.every((l) => l.source === 'fork')).toBe(true);

    await runSyncStatsRefresh({ userId: forker });
    let doc = await User.findById(forker).lean<{ stats: { syncedLines: number; minutesSynced: number } }>();
    expect(doc!.stats.syncedLines).toBe(0);
    expect(doc!.stats.minutesSynced).toBe(0);

    // Re-timing every line by hand turns the fork into the forker's own work.
    await patchProject(forked.publicId, { lyrics: { lines: Array.from({ length: 10 }, (_, i) => ({ sectionIdx: 0, lineIdx: i, line: { text: `l${i}`, timestamp: (i + 1) * 60, source: 'manual' } })) } }, forker);
    await runSyncStatsRefresh({ userId: forker });
    doc = await User.findById(forker).lean<{ stats: { syncedLines: number; minutesSynced: number }; progression?: { xp?: number } }>();
    expect(doc!.stats.syncedLines).toBe(10);
    expect(doc!.stats.minutesSynced).toBe(10);
    expect((doc as { progression?: { xp?: number } }).progression?.xp).toBe(10 * 3 + 0); // 10 min x 3 XP, no badges yet
  });
});

describe('retired built-in badge', () => {
  it('is deleted and taken off holders, with their XP rebuilt', async () => {
    await BadgeDefinition.create({ id: 'admin', label: { en: 'Staff' }, color: 'rose', conditionType: 'role_admin', isBuiltin: true, xpReward: 500 });
    const u = await mkUser({ badges: [{ id: 'admin', grantedAt: new Date(), grantedBy: 'system' }], showcasedBadges: ['admin'], progression: { xp: 500, level: 2, bonusXp: 0 } });
    await UserPreferences.create({ userId: u, miniProfileBadgeIds: ['admin'] });

    expect(await retireBuiltinBadges()).toBe(1);
    expect(await BadgeDefinition.exists({ id: 'admin' })).toBeNull();
    const doc = await User.findById(u).lean<{ badges: unknown[]; showcasedBadges: string[]; progression: { xp: number } }>();
    expect(doc!.badges).toHaveLength(0);
    expect(doc!.showcasedBadges).toEqual([]);
    expect(doc!.progression.xp).toBe(0); // the 500 XP came only from that badge
    expect((await UserPreferences.findOne({ userId: u }).lean<{ miniProfileBadgeIds: string[] }>())!.miniProfileBadgeIds).toEqual([]);
    expect(await retireBuiltinBadges()).toBe(0); // idempotent
  });
});

describe('level title privacy', () => {
  it('leaves out users who hid their title, enforced where the titles are built', async () => {
    const shown = await mkUser();
    const hidden = await mkUser();
    await UserPreferences.create({ userId: hidden, showAddictionTitle: false });
    const titles = await getAddictionTitles([shown, hidden]);
    expect(titles.has(shown)).toBe(true);
    expect(titles.has(hidden)).toBe(false);
  });
});
