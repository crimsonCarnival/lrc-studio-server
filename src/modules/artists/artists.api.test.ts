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
vi.mock('../notifications/notifications.service.js', () => ({ upsertSocial: async () => undefined }));

import Artist from '../../db/artist.model.js';
import User from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import ProjectFork from '../projects/projectFork.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import { createProject, patchProject } from '../projects/projects.crud.service.js';
import { cloneProject } from '../projects/projects.sharing.service.js';
import { suggestArtists, SUGGESTION_MAX_LIMIT } from './artist.service.js';
import { migrateArtists } from './artist-migration.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([Artist.init(), Project.init(), Lyrics.init(), ProjectFork.init(), User.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([Artist.deleteMany({}), Project.deleteMany({}), Lyrics.deleteMany({}), ProjectFork.deleteMany({}), User.deleteMany({})]);
});

// Owners must be real User documents with an accountName: project URLs are
// owner-scoped (`/:accountName/projects/:slug-:publicId`) and projectPath()
// throws for an owner without one, so a bare random ObjectId would fail every
// create/clone here instead of exercising the real path.
let userSeq = 0;
const uid = async (): Promise<string> => {
  const n = ++userSeq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `owner${n}`,
    email: `owner${n}@x.test`,
    passwordHash: 'x',
  });
  return insertedId.toString();
};
const credit = (name: string, role: 'primary' | 'featured') => ({ name, role });

async function create(userId: string, input: Record<string, unknown>) {
  const r = await createProject({ public: true, ...input }, userId, '127.0.0.1');
  return r as { publicId: string; url: string; error?: string; code?: string; status?: number };
}
const stored = (publicId: string) => Project.findOne({ publicId }).lean<{
  slug: string; title: string;
  metadata: { songArtist: string; artists: { name: string; role: string; order: number; artistId: mongoose.Types.ObjectId }[] };
}>();

describe('create', () => {
  it('stores credits, links the owner’s artist records and derives songArtist and slug', async () => {
    const u = await uid();
    const r = await create(u, {
      title: 'Song',
      metadata: { songName: 'Song', artists: [credit('Drake', 'primary'), credit('Rihanna', 'featured')] },
    });
    const p = await stored(r.publicId);
    expect(p!.metadata.songArtist).toBe('Drake feat. Rihanna');
    expect(p!.metadata.artists.map((a) => `${a.role}:${a.name}:${a.order}`)).toEqual(['primary:Drake:0', 'featured:Rihanna:1']);
    expect(p!.metadata.artists.every((a) => !!a.artistId)).toBe(true);
    expect(p!.slug).toBe('drake-feat-rihanna-song');
    expect(r.url).toMatch(/\/projects\/drake-feat-rihanna-song-/);
    expect(await Artist.countDocuments({ userId: u })).toBe(2);
  });

  it('ignores a legacy songArtist string (it is derived now) and a client-sent artistId', async () => {
    const u = await uid();
    const foreign = new mongoose.Types.ObjectId();
    const legacy = await create(u, { title: 'T', metadata: { songArtist: 'Drake feat. Rihanna' } });
    expect((await stored(legacy.publicId))!.metadata.songArtist).toBe('');

    const forged = await create(u, { title: 'T', metadata: { artists: [{ ...credit('Drake', 'primary'), artistId: foreign }] } });
    const ids = (await stored(forged.publicId))!.metadata.artists.map((a) => String(a.artistId));
    expect(ids).not.toContain(String(foreign));
  });

  it('rejects invalid credits with a code and creates nothing', async () => {
    const u = await uid();
    for (const [artists, code] of [
      [[credit('A', 'primary'), credit(' a ', 'featured')], 'artist_duplicate'],
      [[credit('A', 'featured')], 'artist_primary_required'],
      [[credit('   ', 'primary')], 'artist_name_empty'],
    ] as const) {
      const r = await create(u, { title: 'T', metadata: { artists } });
      expect(r).toMatchObject({ code, status: 422 });
    }
    expect(await Project.countDocuments({})).toBe(0);
  });
});

describe('update', () => {
  it('adds featured artists, keeps them when artists is omitted, and clears with []', async () => {
    const u = await uid();
    const { publicId } = await create(u, { title: 'Song', metadata: { artists: [credit('Drake', 'primary')] } });

    await patchProject(publicId, { metadata: { artists: [credit('Drake', 'primary'), credit('A', 'featured'), credit('B', 'featured')] } }, u);
    expect((await stored(publicId))!.metadata.songArtist).toBe('Drake feat. A & B');

    await patchProject(publicId, { metadata: { description: 'only this' } }, u);
    const kept = await stored(publicId);
    expect(kept!.metadata.songArtist).toBe('Drake feat. A & B');
    expect(kept!.metadata.artists).toHaveLength(3);

    await patchProject(publicId, { metadata: { artists: [] } }, u);
    const cleared = await stored(publicId);
    expect(cleared!.metadata.artists).toHaveLength(0);
    expect(cleared!.metadata.songArtist).toBe('');
    expect(cleared!.slug).toBe('song');
  });

  it('rejects invalid credits and leaves the project as it was', async () => {
    const u = await uid();
    const { publicId } = await create(u, { title: 'Song', metadata: { artists: [credit('Drake', 'primary')] } });
    const r = await patchProject(publicId, { metadata: { artists: [credit('A', 'featured')] } }, u);
    expect(r).toMatchObject({ code: 'artist_primary_required' });
    expect((await stored(publicId))!.metadata.songArtist).toBe('Drake');
  });

  it('a legacy row without artists keeps its songArtist through an unrelated edit', async () => {
    const u = await uid();
    const legacy = await Project.collection.insertOne({
      publicId: 'legacy0001', userId: new mongoose.Types.ObjectId(u), public: true, title: 'T',
      metadata: { songArtist: 'Old Text' },
    });
    expect(legacy.acknowledged).toBe(true);
    await patchProject('legacy0001', { metadata: { description: 'x' } }, u);
    expect((await stored('legacy0001'))!.metadata.songArtist).toBe('Old Text');
  });
});

describe('search', () => {
  it('a featured artist’s name matches the song (it is part of songArtist)', async () => {
    const u = await uid();
    await create(u, { title: 'Song', metadata: { artists: [credit('Drake', 'primary'), credit('Rihanna', 'featured')] } });
    const hits = await Project.find({ 'metadata.songArtist': /rihanna/i }).lean();
    expect(hits).toHaveLength(1);
  });
});

describe('autocomplete scoping', () => {
  it('only returns the caller’s own artists, by prefix, paginated and capped', async () => {
    const [a, b] = [await uid(), await uid()];
    await create(a, { title: 'x', metadata: { artists: [credit('Drake', 'primary'), credit('Dua Lipa', 'featured'), credit('Daft Punk', 'featured')] } });
    await create(b, { title: 'y', metadata: { artists: [credit('Dracula Band', 'primary')] } });

    const mine = await suggestArtists(a, 'dr');
    expect(mine.items.map((i) => i.name)).toEqual(['Drake']);
    expect(mine.total).toBe(1);
    expect((await suggestArtists(b, 'dr')).items.map((i) => i.name)).toEqual(['Dracula Band']);

    const all = await suggestArtists(a, 'd', 2, 0);
    expect(all.items.map((i) => i.name)).toEqual(['Daft Punk', 'Drake']);
    expect(all.total).toBe(3);
    expect((await suggestArtists(a, 'd', 2, 2)).items.map((i) => i.name)).toEqual(['Dua Lipa']);
    expect((await suggestArtists(a, '', 1000)).items.length).toBeLessThanOrEqual(SUGGESTION_MAX_LIMIT);
  });

  it('treats the prefix as text, not a pattern', async () => {
    const a = await uid();
    await create(a, { title: 'x', metadata: { artists: [credit('A.B', 'primary'), credit('AxB', 'featured')] } });
    expect((await suggestArtists(a, 'a.')).items.map((i) => i.name)).toEqual(['A.B']);
    expect((await suggestArtists(a, '.*')).items).toEqual([]);
  });
});

describe('fork', () => {
  it('re-links credits to the forker’s own artist records', async () => {
    const [owner, forker] = [await uid(), await uid()];
    const { publicId } = await create(owner, { title: 'Song', metadata: { artists: [credit('Drake', 'primary'), credit('Rihanna', 'featured')] } });
    const forked = await cloneProject(publicId, forker);
    const f = await stored((forked as { publicId: string }).publicId);
    const ownerIds = (await stored(publicId))!.metadata.artists.map((x) => String(x.artistId));
    const forkIds = f!.metadata.artists.map((x) => String(x.artistId));
    expect(f!.metadata.songArtist).toBe('Drake feat. Rihanna');
    expect(forkIds.every((id) => !ownerIds.includes(id))).toBe(true);
    expect(await Artist.countDocuments({ _id: { $in: forkIds }, userId: forker })).toBe(2);
  });
});

describe('migrateArtists runner', () => {
  const insert = (publicId: string, songArtist: string, songName = 'Song', title = '') =>
    Project.collection.insertOne({ publicId, userId: new mongoose.Types.ObjectId(), public: true, title, metadata: { songArtist, songName } });

  it('dry run reports and writes nothing; --write applies unambiguous rows; a re-run changes nothing', async () => {
    await insert('feat000001', 'Drake feat. Rihanna', 'Song (feat. Kanye)');
    await insert('amb0000001', 'Simon & Garfunkel');
    await insert('plain00001', 'Solo');

    const dry = await migrateArtists({ write: false });
    expect(dry).toMatchObject({ dryRun: true, apply: 2, ambiguous: 1, written: 0 });
    expect((await stored('feat000001'))!.metadata.artists ?? []).toHaveLength(0);

    const real = await migrateArtists({ write: true });
    expect(real.written).toBe(2);
    const migrated = await stored('feat000001');
    expect(migrated!.metadata.artists.map((a) => a.name)).toEqual(['Drake', 'Rihanna', 'Kanye']);
    expect(migrated!.metadata.songArtist).toBe('Drake feat. Rihanna & Kanye');
    expect(migrated!.slug).toBe('drake-feat-rihanna-kanye-song');
    expect((await Project.collection.findOne({ publicId: 'feat000001' }) as { metadata: { songName: string } }).metadata.songName).toBe('Song');
    expect((await stored('amb0000001'))!.metadata.artists ?? []).toHaveLength(0);

    const again = await migrateArtists({ write: true });
    expect(again).toMatchObject({ apply: 0, written: 0, ambiguous: 1 });

    const withAmbiguous = await migrateArtists({ write: true, includeAmbiguous: true });
    expect(withAmbiguous.written).toBe(1);
    expect((await stored('amb0000001'))!.metadata.artists.map((a) => a.name)).toEqual(['Simon', 'Garfunkel']);
  });
});
