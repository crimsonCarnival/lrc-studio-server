import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import User from '../users/user.model.js';
import Project from '../projects/project.model.js';
import Notification from '../notifications/notification.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import CatalogSubmissionLog from './catalog-submission-log.model.js';
import { runBackfill, BACKFILL_DEFAULTS, type BackfillOptions } from './catalog.backfill.js';
import { reviewCatalogEntry } from './catalog.review.service.js';
import { artistKey } from '../artists/artist.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), Project.init(), CatalogArtist.init(), CatalogAlbum.init(), CatalogSubmissionLog.init(), Notification.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Project.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}),
    CatalogSubmissionLog.deleteMany({}), Notification.deleteMany({}),
  ]);
});

let seq = 0;
const seedUser = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `b${n}`, email: `b${n}@x.test`, passwordHash: 'x', isVerified: true, permissions: [], ...extra,
  });
  return insertedId.toString();
};

type Meta = { artists?: { name: string; role: 'primary' | 'featured'; order: number }[]; songArtist?: string; songAlbum?: string };
let day = 0;
const seedProject = async (userId: string | null, metadata: Meta): Promise<void> => {
  const n = ++seq;
  await Project.collection.insertOne({
    publicId: `p${n}`, userId: userId ? new mongoose.Types.ObjectId(userId) : null, title: `t${n}`, public: false,
    metadata: { artists: [], songArtist: '', songAlbum: '', ...metadata }, createdAt: new Date(2026, 0, 1 + day++), updatedAt: new Date(),
  });
};
const primary = (name: string) => ({ artists: [{ name, role: 'primary' as const, order: 0 }] });
const many = async (userId: string | null, n: number, meta: Meta) => { for (let i = 0; i < n; i++) await seedProject(userId, meta); };
const run = (over: Partial<BackfillOptions> = {}) => runBackfill({ ...BACKFILL_DEFAULTS, ...over });
const counts = async () => ({
  artists: await CatalogArtist.countDocuments(), albums: await CatalogAlbum.countDocuments(), log: await CatalogSubmissionLog.countDocuments(),
});
const rowOf = (r: Awaited<ReturnType<typeof run>>, name: string) => r.rows.find((x) => x.name === name);
const seedCatalogArtist = (name: string, status: 'approved' | 'pending' | 'rejected', by: string) =>
  CatalogArtist.create({
    name, nameKey: artistKey(name), status, source: 'community', submittedBy: new mongoose.Types.ObjectId(by),
    slug: status === 'approved' ? artistKey(name).replace(/\W+/g, '-') : null,
  });

describe('backfill: artist extraction', () => {
  it('turns structured credits into one candidate across projects', async () => {
    const u = await seedUser();
    await many(u, 3, primary('Björk'));
    const r = await run();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ kind: 'artist', name: 'Björk', projectCount: 3, userCount: 1, status: 'create', chosenSubmitterId: u });
  });

  it('splits a legacy string only when the parse is sure, else keeps it whole', async () => {
    const u = await seedUser();
    await many(u, 2, { songArtist: 'Alpha, Beta' });
    await many(u, 2, { songArtist: 'Simon & Garfunkel' });
    const r = await run({ limit: 100, perUser: 100 });
    const names = r.rows.map((x) => x.name).sort();
    expect(names).toEqual(['Alpha', 'Beta', 'Simon & Garfunkel']);
  });

  it('cleans HTML and whitespace, and skips over-long names', async () => {
    const u = await seedUser();
    await seedProject(u, primary('  <b>Daft</b>   Punk '));
    await seedProject(u, primary('Daft Punk'));
    await many(u, 2, primary('x'.repeat(301)));
    const r = await run();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: 'Daft Punk', projectCount: 2 });
  });

  it('counts a project once per candidate even if credited twice', async () => {
    const u = await seedUser();
    await seedProject(u, { artists: [{ name: 'Dup', role: 'primary', order: 0 }, { name: 'dup', role: 'featured', order: 1 }] });
    await seedProject(u, primary('Dup'));
    expect(rowOf(await run(), 'Dup')).toMatchObject({ projectCount: 2 });
  });
});

describe('backfill: filters', () => {
  it('applies the min-songs threshold', async () => {
    const u = await seedUser();
    await seedProject(u, primary('Once'));
    await many(u, 2, primary('Twice'));
    const r = await run();
    expect(rowOf(r, 'Once')!.status).toBe('below_threshold');
    expect(rowOf(r, 'Twice')!.status).toBe('create');
    expect((await run({ minSongs: 1, limit: 10, perUser: 10 })).rows.every((x) => x.status === 'create')).toBe(true);
  });

  it.each(['approved', 'pending', 'rejected'] as const)('skips a candidate whose %s twin exists', async (status) => {
    const u = await seedUser();
    const other = await seedUser();
    await seedCatalogArtist('Twin', status, other);
    await many(u, 3, primary('TWIN'));
    const r = await run({ write: true });
    expect(rowOf(r, 'TWIN')).toMatchObject({ status: 'skipped_existing', reason: status });
    expect(await CatalogArtist.countDocuments()).toBe(1);
  });

  it('picks the user with the most projects as submitter', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await many(a, 1, primary('Shared'));
    await many(b, 3, primary('Shared'));
    const row = rowOf(await run(), 'Shared')!;
    expect(row).toMatchObject({ chosenSubmitterId: b, userCount: 2, projectCount: 4 });
  });

  it('breaks ties by earliest project', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await seedProject(b, primary('Tie'));
    await seedProject(a, primary('Tie'));
    expect(rowOf(await run(), 'Tie')!.chosenSubmitterId).toBe(b);
  });

  it('falls to the next user when the best is unverified, banned or deleted', async () => {
    const good = await seedUser();
    for (const bad of [{ isVerified: false }, { ban: { active: true } }, { isDeleted: true }]) {
      await Promise.all([Project.deleteMany({}), CatalogArtist.deleteMany({})]);
      const b = await seedUser(bad);
      await many(b, 3, primary('Fall'));
      await many(good, 1, primary('Fall'));
      expect(rowOf(await run(), 'Fall')!.chosenSubmitterId).toBe(good);
    }
  });

  it('reports no_eligible_submitter when nobody qualifies (including ownerless projects)', async () => {
    const bad = await seedUser({ isVerified: false });
    await many(bad, 2, primary('Nobody'));
    await many(null, 2, primary('Orphan'));
    const r = await run();
    expect(rowOf(r, 'Nobody')!.status).toBe('no_eligible_submitter');
    expect(rowOf(r, 'Orphan')!.status).toBe('no_eligible_submitter');
  });

  it('skips a submitter already near their pending cap', async () => {
    const u = await seedUser();
    const other = await seedUser();
    for (let i = 0; i < 4; i++) await seedCatalogArtist(`Existing ${i}`, 'pending', u);
    await many(u, 3, primary('Capped'));
    await many(other, 1, primary('Capped'));
    expect(rowOf(await run(), 'Capped')!.chosenSubmitterId).toBe(other);
  });
});

describe('backfill: limits', () => {
  it('respects --limit, highest project count first', async () => {
    for (const [name, n] of [['A', 4], ['B', 3], ['C', 2]] as const) await many(await seedUser(), n, primary(name));
    const r = await run({ limit: 2 });
    expect(rowOf(r, 'A')!.status).toBe('create');
    expect(rowOf(r, 'B')!.status).toBe('create');
    expect(rowOf(r, 'C')!.status).toBe('over_limit');
  });

  it('respects --per-user, using the next best user when the top one is used up', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await many(a, 3, primary('One'));
    await many(b, 1, primary('One'));
    await many(a, 2, primary('Two'));
    const r = await run();
    expect(rowOf(r, 'One')).toMatchObject({ status: 'create', chosenSubmitterId: a });
    expect(rowOf(r, 'Two')).toMatchObject({ status: 'per_user_limit' });
    expect(r.rows.filter((x) => x.status === 'create')).toHaveLength(1);
  });

  it('allows more per user when asked', async () => {
    const a = await seedUser();
    await many(a, 2, primary('One'));
    await many(a, 2, primary('Two'));
    expect((await run({ perUser: 2 })).summary.create).toBe(2);
  });
});

describe('backfill: write', () => {
  it('dry run writes nothing', async () => {
    const u = await seedUser();
    await many(u, 3, primary('Dry'));
    const before = await counts();
    const r = await run();
    expect(r.summary.create).toBe(1);
    expect(r.summary.created).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it('creates pending community entries with correct keys, no log rows, and is idempotent', async () => {
    const u = await seedUser();
    await many(u, 2, primary('Sigur Rós'));
    const r = await run({ write: true });
    expect(r.summary.created).toBe(1);
    const doc = await CatalogArtist.findOne().lean();
    expect(doc).toMatchObject({
      name: 'Sigur Rós', nameKey: artistKey('Sigur Rós'), status: 'pending', source: 'community', slug: null, bio: '', imageUrl: null,
    });
    expect(String(doc!.submittedBy)).toBe(u);
    expect(await CatalogSubmissionLog.countDocuments()).toBe(0);

    const again = await run({ write: true });
    expect(again.summary.created).toBe(0);
    expect(rowOf(again, 'Sigur Rós')).toMatchObject({ status: 'skipped_existing', reason: 'pending' });
    expect(await CatalogArtist.countDocuments()).toBe(1);
  });

  it('created entries go through the real review flow and credit the submitter', async () => {
    const u = await seedUser();
    const reviewer = await seedUser({ permissions: ['catalog.review'] });
    await many(u, 2, primary('Reviewed'));
    await run({ write: true });
    const entry = await CatalogArtist.findOne().lean();
    const res = await reviewCatalogEntry({ userId: reviewer, permissions: ['catalog.review'] }, 'artist', String(entry!._id), 'approve');
    expect('entry' in res).toBe(true);
    expect((await CatalogArtist.findById(entry!._id))!.status).toBe('approved');
    await vi.waitFor(async () => {
      const s = (await User.findById(u).lean<{ stats?: { catalogArtistsApproved?: number } }>())?.stats;
      expect(s?.catalogArtistsApproved).toBe(1);
    });
    expect(await Notification.countDocuments({ userId: new mongoose.Types.ObjectId(u) })).toBeGreaterThan(0);
  });
});

describe('backfill: albums phase', () => {
  const album = (artist: string, title: string): Meta => ({ ...primary(artist), songAlbum: title });

  it('creates albums only under an approved parent, attributed to the primary artist', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const parent = await seedCatalogArtist('Parent', 'approved', other);
    await seedCatalogArtist('Unapproved', 'pending', other);
    await many(u, 2, { artists: [{ name: 'Guest', role: 'featured', order: 0 }, { name: 'Parent', role: 'primary', order: 1 }], songAlbum: ' Good  Album ' });
    await many(u, 2, album('Unapproved', 'Hidden'));
    await many(u, 2, album('Nobody In Catalog', 'Lost'));
    const r = await run({ phase: 'albums', write: true, perUser: 5, limit: 10 });
    expect(rowOf(r, 'Good Album')).toMatchObject({ kind: 'album', artistName: 'Parent', status: 'create' });
    expect(rowOf(r, 'Hidden')!.status).toBe('parent_not_approved');
    expect(rowOf(r, 'Lost')!.status).toBe('parent_not_approved');
    const docs = await CatalogAlbum.find().lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title: 'Good Album', titleKey: 'good album', status: 'pending', source: 'community', slug: null, year: null, coverUrl: null });
    expect(String(docs[0].artistId)).toBe(String(parent._id));
    expect(String(docs[0].submittedBy)).toBe(u);
    expect(await CatalogSubmissionLog.countDocuments()).toBe(0);
  });

  it('skips albums with no clear primary and existing twins (any status)', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const parent = await seedCatalogArtist('Parent', 'approved', other);
    await CatalogAlbum.create({
      artistId: parent._id, title: 'Burned', titleKey: 'burned', status: 'rejected', source: 'community', submittedBy: new mongoose.Types.ObjectId(other),
    });
    await many(u, 2, { artists: [{ name: 'Only Feat', role: 'featured', order: 0 }], songAlbum: 'Orphan Album' });
    await many(u, 2, { songArtist: 'A & B', songAlbum: 'Ambiguous' });
    await many(u, 2, album('Parent', 'Burned'));
    const r = await run({ phase: 'albums', write: true });
    expect(rowOf(r, 'Orphan Album')!.status).toBe('no_primary_artist');
    expect(rowOf(r, 'Ambiguous')!.status).toBe('no_primary_artist');
    expect(rowOf(r, 'Burned')).toMatchObject({ status: 'skipped_existing', reason: 'rejected' });
    expect(await CatalogAlbum.countDocuments()).toBe(1);
  });
});
