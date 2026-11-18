import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../users/user.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { planRelabel, isCatalogStaff, runRelabel, type RelabelRow } from './catalog.relabel.js';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({})]);
});

const row = (kind: 'artist' | 'album', id: string, submittedBy: string, creditAwarded = false): RelabelRow => ({
  kind, id, submittedBy, status: 'approved', creditAwarded,
});

describe('planRelabel', () => {
  it('keeps only rows submitted by staff', () => {
    const plan = planRelabel([row('artist', 'a1', 's'), row('artist', 'a2', 'u'), row('album', 'b1', 's'), row('album', 'b2', 'u')], new Set(['s']));
    expect(plan.ids).toEqual({ artist: ['a1'], album: ['b1'] });
    expect(plan.counts).toEqual({ artist: 1, album: 1 });
  });

  it('counts creditAwarded per kind without dropping those rows', () => {
    const plan = planRelabel([row('artist', 'a1', 's', true), row('artist', 'a2', 's'), row('album', 'b1', 's', true)], new Set(['s']));
    expect(plan.creditAwarded).toEqual({ artist: 1, album: 1 });
    expect(plan.ids.artist).toEqual(['a1', 'a2']);
  });

  it('empty staff set plans nothing', () => {
    const plan = planRelabel([row('artist', 'a1', 's'), row('album', 'b1', 's')], new Set());
    expect(plan).toEqual({ counts: { artist: 0, album: 0 }, creditAwarded: { artist: 0, album: 0 }, ids: { artist: [], album: [] } });
  });
});

describe('isCatalogStaff', () => {
  it('is true for catalog.manage', () => expect(isCatalogStaff({ permissions: ['catalog.manage'] })).toBe(true));
  it('is true for superadmin without permissions', () => expect(isCatalogStaff({ role: 'superadmin' })).toBe(true));
  it('is false for catalog.review only', () => expect(isCatalogStaff({ permissions: ['catalog.review'], role: 'mod' })).toBe(false));
});

let seq = 0;
const seedUser = async (extra: Record<string, unknown> = {}): Promise<mongoose.Types.ObjectId> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `r${n}`, email: `r${n}@x.test`, passwordHash: 'x', permissions: [], progression: { xp: 10 }, ...extra,
  });
  return insertedId;
};
const seedArtist = (name: string, by: mongoose.Types.ObjectId) =>
  CatalogArtist.create({ name, nameKey: name.toLowerCase(), status: 'approved', source: 'community', submittedBy: by, creditAwarded: true, slug: name.toLowerCase() });
const seedAlbum = async (title: string, by: mongoose.Types.ObjectId) => {
  const artist = await seedArtist(`${title}-artist`, by);
  return CatalogAlbum.collection.insertOne({
    title, titleKey: title.toLowerCase(), artistId: artist._id, status: 'approved', source: 'community', submittedBy: by,
    creditAwarded: true, slug: title.toLowerCase(), createdAt: new Date(2026, 0, 1), updatedAt: new Date(2026, 0, 1),
  });
};

describe('runRelabel', () => {
  it('dry run reports and writes nothing', async () => {
    const staff = await seedUser({ permissions: ['catalog.manage'] });
    await seedArtist('A', staff);
    const r = await runRelabel({ write: false });
    expect(r).toMatchObject({ write: false, modified: 0, counts: { artist: 1, album: 0 } });
    expect(await CatalogArtist.countDocuments({ source: 'community' })).toBe(1);
  });

  it('write relabels staff rows only, keeps updatedAt and creditAwarded', async () => {
    const staff = await seedUser({ permissions: ['catalog.manage'] });
    const superadmin = await seedUser({ role: 'superadmin' });
    const community = await seedUser();
    const sa = await seedArtist('Staff', staff);
    await seedArtist('Super', superadmin);
    const ca = await seedArtist('Comm', community);
    await seedAlbum('StaffAlbum', staff);
    await seedAlbum('CommAlbum', community);
    const before = (await CatalogArtist.findById(sa._id).lean())!.updatedAt;

    const r = await runRelabel({ write: true });
    // artists: Staff, Super, plus the helper artists created for the albums (StaffAlbum-artist is staff's)
    expect(r.counts).toEqual({ artist: 3, album: 1 });
    expect(r.modified).toBe(4);
    const after = await CatalogArtist.findById(sa._id).lean();
    expect(after!.source).toBe('admin');
    expect(after!.updatedAt).toEqual(before);
    expect(after!.creditAwarded).toBe(true);
    expect((await CatalogArtist.findById(ca._id).lean())!.source).toBe('community');
    expect(await CatalogAlbum.countDocuments({ source: 'admin' })).toBe(1);
    expect(await CatalogAlbum.countDocuments({ source: 'community' })).toBe(1);
    expect((await User.collection.findOne({ _id: community }))!.progression).toEqual({ xp: 10 });
    expect((await User.collection.findOne({ _id: staff }))!.progression).toEqual({ xp: 10 });
  });

  it('second write run is a no-op', async () => {
    const staff = await seedUser({ permissions: ['catalog.manage'] });
    await seedArtist('A', staff);
    await runRelabel({ write: true });
    const r = await runRelabel({ write: true });
    expect(r.modified).toBe(0);
    expect(r.counts).toEqual({ artist: 0, album: 0 });
  });
});
