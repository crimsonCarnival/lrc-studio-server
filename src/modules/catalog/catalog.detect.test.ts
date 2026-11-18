import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../badges/badge.service.js', () => ({ triggerBadgeCheck: async () => [] }));
vi.mock('./catalog.rewards.js', () => ({ awardCatalogCredit: async () => undefined, revokeCatalogCredit: async () => undefined }));

import User from '../users/user.model.js';
import AdminLog from '../admin/admin-log.model.js';
import Project from '../projects/project.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import CatalogAlbumDismissal from './catalog-album-dismissal.model.js';
import { detectAlbums, approveDetectedAlbum, dismissDetectedAlbum } from './catalog.detect.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), CatalogArtist.init(), CatalogAlbum.init(), CatalogAlbumDismissal.init(), AdminLog.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}),
    CatalogAlbumDismissal.deleteMany({}), AdminLog.deleteMany({}), Project.collection.deleteMany({}),
  ]);
});

let seq = 0;
const seedUser = async (permissions: string[] = ['catalog.manage']): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `d${n}`, email: `d${n}@x.test`, passwordHash: 'x', isVerified: true, permissions,
  });
  return insertedId.toString();
};
const seedArtist = async (admin: string, name = 'Björk', status = 'approved') => {
  const a = await CatalogArtist.create({
    name, nameKey: name.normalize('NFC').toLowerCase(), slug: status === 'approved' ? name.toLowerCase().replace(/\W/g, '') : null,
    status, source: 'admin', submittedBy: new mongoose.Types.ObjectId(admin),
  });
  return String(a._id);
};
type Seed = { user?: string; kind?: string; public?: boolean; artists?: { name: string; role: string }[]; album?: string | null; year?: string };
const seedProject = (o: Seed) =>
  Project.collection.insertOne({
    publicId: `p${++seq}`, userId: new mongoose.Types.ObjectId(o.user ?? undefined), title: 'SECRET TITLE', kind: o.kind ?? 'song', public: o.public ?? false,
    metadata: { artists: o.artists ?? [{ name: 'Björk', role: 'primary' }], songAlbum: o.album ?? '', songYear: o.year ?? '' },
  });
const seedMany = async (n: number, o: Seed) => { for (let i = 0; i < n; i++) await seedProject(o); };
const list = async (admin: string, artist: string) => (await detectAlbums(admin, artist)) as { key: string; title: string; songCount: number; year: string | null }[];
const errOf = (r: unknown) => r as { error: string; status: number; code: string };

describe('detectAlbums', () => {
  it('matches primary credits by name key across users and visibilities', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'Homogenic', public: true });
    await seedProject({ album: 'Homogenic', public: false });
    expect(await list(admin, artist)).toEqual([{ key: 'homogenic', title: 'Homogenic', songCount: 2, year: null }]);
  });

  it('matches case and non-ASCII variants', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin, 'Björk');
    await seedProject({ album: 'Post', artists: [{ name: 'BJÖRK', role: 'primary' }] });
    await seedProject({ album: 'Post', artists: [{ name: 'björk', role: 'primary' }] });
    expect((await list(admin, artist))[0].songCount).toBe(2);
  });

  it('ignores featured-only credits', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'X', artists: [{ name: 'Other', role: 'primary' }, { name: 'Björk', role: 'featured' }] });
    expect(await list(admin, artist)).toEqual([]);
  });

  it('excludes subtitles projects', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'X', kind: 'subtitles' });
    expect(await list(admin, artist)).toEqual([]);
  });

  it('ignores empty albums', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: '' });
    await seedProject({ album: null });
    expect(await list(admin, artist)).toEqual([]);
  });

  it('groups spellings under one key and picks the most frequent title and year', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedMany(2, { album: 'Homogenic', year: '1997' });
    await seedProject({ album: 'homogenic ', year: '97' });
    expect(await list(admin, artist)).toEqual([{ key: 'homogenic', title: 'Homogenic', songCount: 3, year: '1997' }]);
  });

  it('excludes albums already in the catalog in any status', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    for (const [i, status] of (['pending', 'rejected', 'approved'] as const).entries()) {
      await CatalogAlbum.create({
        artistId: new mongoose.Types.ObjectId(artist), title: `Cat${i}`, titleKey: `cat${i}`, status, source: 'admin',
        submittedBy: new mongoose.Types.ObjectId(admin),
      });
      await seedProject({ album: `Cat${i}` });
    }
    await seedProject({ album: 'Fresh' });
    expect((await list(admin, artist)).map((r) => r.key)).toEqual(['fresh']);
  });

  it('excludes dismissed keys', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'Nope' });
    await seedProject({ album: 'Yes' });
    await dismissDetectedAlbum(admin, artist, 'NOPE');
    expect((await list(admin, artist)).map((r) => r.key)).toEqual(['yes']);
  });

  it('sorts by songCount then title and caps at 100', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedMany(2, { album: 'Zed' });
    await seedProject({ album: 'Bravo' });
    await seedProject({ album: 'Alpha' });
    for (let i = 0; i < 99; i++) await seedProject({ album: `Filler ${String(i).padStart(3, '0')}` });
    const r = await list(admin, artist);
    expect(r).toHaveLength(100);
    expect(r.slice(0, 3).map((x) => x.title)).toEqual(['Zed', 'Alpha', 'Bravo']);
  });

  it('returns aggregates only', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'Post', year: '1995' });
    const r = await list(admin, artist);
    expect(Object.keys(r[0])).toEqual(['key', 'title', 'songCount', 'year']);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('non-manager is forbidden', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    const nobody = await seedUser([]);
    expect(errOf(await detectAlbums(nobody, artist)).code).toBe('CATALOG_FORBIDDEN');
  });

  it('unknown or pending artist -> CATALOG_NOT_FOUND', async () => {
    const admin = await seedUser();
    const pending = await seedArtist(admin, 'Pend', 'pending');
    expect(errOf(await detectAlbums(admin, pending)).code).toBe('CATALOG_NOT_FOUND');
    expect(errOf(await detectAlbums(admin, String(new mongoose.Types.ObjectId()))).code).toBe('CATALOG_NOT_FOUND');
  });
});

describe('approve and dismiss', () => {
  it('approve creates an approved admin album and it leaves the findings', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'Post', year: '1995' });
    const r = (await approveDetectedAlbum(admin, artist, 'Post', '1995')) as { album: any };
    expect(r.album.status).toBe('approved');
    expect(r.album.source).toBe('admin');
    expect(r.album.year).toBe('1995');
    expect(await list(admin, artist)).toEqual([]);
  });

  it('second approve -> CATALOG_DUPLICATE, one album', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await approveDetectedAlbum(admin, artist, 'Post', null);
    expect(errOf(await approveDetectedAlbum(admin, artist, 'Post', null)).code).toBe('CATALOG_DUPLICATE');
    expect(await CatalogAlbum.countDocuments({})).toBe(1);
  });

  it('dismiss is idempotent: one document, one audit row', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    expect(await dismissDetectedAlbum(admin, artist, 'Post')).toEqual({ ok: true });
    expect(await dismissDetectedAlbum(admin, artist, 'post ')).toEqual({ ok: true });
    expect(await CatalogAlbumDismissal.countDocuments({})).toBe(1);
    expect(await AdminLog.countDocuments({ action: 'catalog.dismiss_album' })).toBe(1);
  });

  it('concurrent dismisses both succeed', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    const rs = await Promise.all([dismissDetectedAlbum(admin, artist, 'Post'), dismissDetectedAlbum(admin, artist, 'Post')]);
    expect(rs).toEqual([{ ok: true }, { ok: true }]);
    expect(await CatalogAlbumDismissal.countDocuments({})).toBe(1);
  });

  it('approve and dismiss refuse non-managers', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    const nobody = await seedUser([]);
    expect(errOf(await approveDetectedAlbum(nobody, artist, 'Post', null)).code).toBe('CATALOG_FORBIDDEN');
    expect(errOf(await dismissDetectedAlbum(nobody, artist, 'Post')).code).toBe('CATALOG_FORBIDDEN');
    expect(await CatalogAlbum.countDocuments({})).toBe(0);
  });
});
