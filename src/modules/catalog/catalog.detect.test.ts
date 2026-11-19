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
import CatalogArtistDismissal from './catalog-artist-dismissal.model.js';
import { detectAlbums, approveDetectedAlbum, dismissDetectedAlbum, detectArtists, approveDetectedArtist, dismissDetectedArtist } from './catalog.detect.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), CatalogArtist.init(), CatalogAlbum.init(), CatalogAlbumDismissal.init(), CatalogArtistDismissal.init(), AdminLog.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}),
    CatalogAlbumDismissal.deleteMany({}), CatalogArtistDismissal.deleteMany({}), AdminLog.deleteMany({}), Project.collection.deleteMany({}),
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

describe('detectAlbums spellings and normalisation', () => {
  it('keeps case variants apart so the most frequent spelling wins', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'HOMOGENIC' });
    await seedMany(2, { album: 'Homogenic' });
    expect(await list(admin, artist)).toEqual([{ key: 'homogenic', title: 'Homogenic', songCount: 3, year: null }]);
  });

  it('matches an NFD-stored credit', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin, 'Björk'); // NFC: precomposed o-umlaut
    const nfd = 'Björk'; // NFD: o + combining diaeresis
    expect(nfd).not.toBe('Björk');
    await seedProject({ album: 'Post', artists: [{ name: nfd, role: 'primary' }] });
    expect((await list(admin, artist))[0]?.songCount).toBe(1);
  });

  it('matches a CJK credit', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin, '星野源');
    await seedProject({ album: 'Yellow Dancer', artists: [{ name: '星野源', role: 'primary' }] });
    expect((await list(admin, artist))[0]?.songCount).toBe(1);
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

  it('a finding with markup is shown clean and leaves the findings once approved', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: '<i>Medúlla</i>  Live' });
    const [finding] = await list(admin, artist);
    expect(finding.title).toBe('Medúlla Live');
    await approveDetectedAlbum(admin, artist, finding.title, null);
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

  it('dismiss normalises internal whitespace like detection', async () => {
    const admin = await seedUser();
    const artist = await seedArtist(admin);
    await seedProject({ album: 'Big   Album' });
    await dismissDetectedAlbum(admin, artist, 'Big   Album');
    expect(await list(admin, artist)).toEqual([]);
    expect((await CatalogAlbumDismissal.findOne({}).lean())?.titleKey).toBe('big album');
  });

  it('dismiss refuses a pending artist', async () => {
    const admin = await seedUser();
    const pending = await seedArtist(admin, 'Pend', 'pending');
    expect(errOf(await dismissDetectedAlbum(admin, pending, 'x')).code).toBe('CATALOG_NOT_FOUND');
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

describe('detectArtists', () => {
  type Found = { key: string; name: string; songCount: number };
  const found = async (admin: string) => (await detectArtists(admin)) as Found[];

  it('lists primary names across users, groups spellings and picks the most frequent', async () => {
    const admin = await seedUser();
    await seedProject({ artists: [{ name: 'Björk', role: 'primary' }] });
    await seedProject({ artists: [{ name: 'Björk', role: 'primary' }] });
    await seedProject({ artists: [{ name: 'BJÖRK', role: 'primary' }] });
    expect(await found(admin)).toEqual([{ key: 'björk', name: 'Björk', songCount: 3 }]);
  });

  it('ignores featured credits, subtitles projects and empty names', async () => {
    const admin = await seedUser();
    await seedProject({ artists: [{ name: 'Lead', role: 'primary' }, { name: 'Guest', role: 'featured' }] });
    await seedProject({ kind: 'subtitles', artists: [{ name: 'Subs', role: 'primary' }] });
    await seedProject({ artists: [{ name: '  ', role: 'primary' }] });
    expect((await found(admin)).map((r) => r.key)).toEqual(['lead']);
  });

  it('counts a project once even if it lists the same primary twice', async () => {
    const admin = await seedUser();
    await seedProject({ artists: [{ name: 'Dup', role: 'primary' }, { name: 'Dup', role: 'primary' }] });
    expect((await found(admin))[0].songCount).toBe(1);
  });

  it('hides names already in the catalog in any status', async () => {
    const admin = await seedUser();
    for (const [i, status] of (['pending', 'rejected', 'approved'] as const).entries()) {
      await seedArtist(admin, `Cat${i}`, status);
      await seedProject({ artists: [{ name: `Cat${i}`, role: 'primary' }] });
    }
    await seedProject({ artists: [{ name: 'Fresh', role: 'primary' }] });
    expect((await found(admin)).map((r) => r.key)).toEqual(['fresh']);
  });

  it('dismissed names stay hidden; dismiss is idempotent with one audit row', async () => {
    const admin = await seedUser();
    await seedProject({ artists: [{ name: 'Nope', role: 'primary' }] });
    await seedProject({ artists: [{ name: 'Yes', role: 'primary' }] });
    expect(await dismissDetectedArtist(admin, 'NOPE')).toEqual({ ok: true });
    expect(await dismissDetectedArtist(admin, 'nope ')).toEqual({ ok: true });
    expect((await found(admin)).map((r) => r.key)).toEqual(['yes']);
    expect(await CatalogArtistDismissal.countDocuments({})).toBe(1);
    expect(await AdminLog.countDocuments({ action: 'catalog.dismiss_artist' })).toBe(1);
  });

  it('sorts by songCount then name and returns aggregates only', async () => {
    const admin = await seedUser();
    await seedMany(2, { artists: [{ name: 'Zed', role: 'primary' }] });
    await seedProject({ artists: [{ name: 'Bravo', role: 'primary' }] });
    await seedProject({ artists: [{ name: 'Alpha', role: 'primary' }] });
    const r = await found(admin);
    expect(r.map((x) => x.name)).toEqual(['Zed', 'Alpha', 'Bravo']);
    expect(Object.keys(r[0])).toEqual(['key', 'name', 'songCount']);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('approve creates an approved admin artist and it leaves the findings', async () => {
    const admin = await seedUser();
    await seedProject({ artists: [{ name: 'Newcomer', role: 'primary' }] });
    const r = (await approveDetectedArtist(admin, 'Newcomer')) as { artist: any };
    expect(r.artist.status).toBe('approved');
    expect(r.artist.source).toBe('admin');
    expect(await found(admin)).toEqual([]);
  });

  it('non-managers are refused everywhere', async () => {
    const nobody = await seedUser([]);
    expect(errOf(await detectArtists(nobody)).code).toBe('CATALOG_FORBIDDEN');
    expect(errOf(await approveDetectedArtist(nobody, 'X')).code).toBe('CATALOG_FORBIDDEN');
    expect(errOf(await dismissDetectedArtist(nobody, 'x')).code).toBe('CATALOG_FORBIDDEN');
    expect(await CatalogArtist.countDocuments({})).toBe(0);
  });
});
