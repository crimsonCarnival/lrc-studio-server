import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
const { revokeCatalogCredit } = vi.hoisted(() => ({ revokeCatalogCredit: vi.fn(async () => undefined) }));
vi.mock('./catalog.rewards.js', () => ({ awardCatalogCredit: async () => undefined, revokeCatalogCredit }));

import User from '../users/user.model.js';
import AdminLog from '../admin/admin-log.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import {
  adminCreateCatalogArtist,
  adminCreateCatalogAlbum,
  adminUpdateCatalogEntry,
  adminDeleteCatalogEntry,
} from './catalog.admin.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), CatalogArtist.init(), CatalogAlbum.init(), AdminLog.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'democloud');
  revokeCatalogCredit.mockClear();
  await Promise.all([User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}), AdminLog.deleteMany({})]);
});

let seq = 0;
const seedUser = async (extra: Record<string, unknown> = {}, permissions: string[] = ['catalog.manage']): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `a${n}`, email: `a${n}@x.test`, passwordHash: 'x', isVerified: true, permissions, ...extra,
  });
  return insertedId.toString();
};
const errOf = (r: object) => r as { error: string; status: number; code: string };
const img = (user = 'someone') => `https://res.cloudinary.com/democloud/image/upload/v1/catalog/${user}/pic.webp`;
const seedCommunity = (Model: mongoose.Model<any>, submittedBy: string, over: Record<string, unknown>) =>
  Model.create({ status: 'approved', source: 'community', submittedBy: new mongoose.Types.ObjectId(submittedBy), creditAwarded: true, ...over });

describe('admin catalog create', () => {
  it('creates an approved admin artist with a slug', async () => {
    const admin = await seedUser();
    const r = (await adminCreateCatalogArtist(admin, { name: ' Björk ', bio: '<b>hi</b>', imageUrl: img() })) as { artist: any };
    expect(r.artist.status).toBe('approved');
    expect(r.artist.source).toBe('admin');
    expect(r.artist.slug).toBe('bjork');
    expect(r.artist.bio).toBe('hi');
  });

  it('refuses callers without catalog.manage, deleted or banned users', async () => {
    const plain = await seedUser({}, []);
    const gone = await seedUser({ isDeleted: true });
    const banned = await seedUser({ ban: { active: true } });
    for (const id of [plain, gone, banned, 'nope']) {
      expect(errOf(await adminCreateCatalogArtist(id, { name: 'X' })).code).toBe('CATALOG_FORBIDDEN');
    }
    expect(await CatalogArtist.countDocuments()).toBe(0);
  });

  it('requires disambiguation against an approved homonym, allows it with one', async () => {
    const admin = await seedUser();
    await adminCreateCatalogArtist(admin, { name: 'Nirvana' });
    const refused = errOf(await adminCreateCatalogArtist(admin, { name: 'nirvana' }));
    expect(refused.code).toBe('CATALOG_DISAMBIGUATION_REQUIRED');
    expect(refused.status).toBe(422);
    const ok = (await adminCreateCatalogArtist(admin, { name: 'Nirvana', disambiguation: 'UK band' })) as { artist: any };
    expect(ok.artist.slug).toBe('nirvana-2');
    expect(await CatalogArtist.countDocuments({ status: 'approved' })).toBe(2);
  });

  it('allows a collision with a pending entry', async () => {
    const admin = await seedUser();
    const u = await seedUser({}, []);
    await seedCommunity(CatalogArtist, u, { name: 'Nirvana', nameKey: 'nirvana', status: 'pending', creditAwarded: false });
    expect('artist' in (await adminCreateCatalogArtist(admin, { name: 'Nirvana' }))).toBe(true);
  });

  it('refuses non-catalog image URLs and over-long disambiguation', async () => {
    const admin = await seedUser();
    expect(errOf(await adminCreateCatalogArtist(admin, { name: 'A', imageUrl: 'https://evil.test/a.png' })).code).toBe('CATALOG_INVALID_IMAGE');
    expect(errOf(await adminCreateCatalogArtist(admin, { name: 'A', imageUrl: 'https://res.cloudinary.com/democloud/image/upload/v1/avatars/x/a.png' })).code).toBe('CATALOG_INVALID_IMAGE');
    expect(errOf(await adminCreateCatalogArtist(admin, { name: 'A', disambiguation: 'x'.repeat(81) })).code).toBe('CATALOG_INVALID_INPUT');
  });

  it('creates albums only under approved artists, any uploader folder', async () => {
    const admin = await seedUser();
    const u = await seedUser({}, []);
    const pending = await seedCommunity(CatalogArtist, u, { name: 'P', nameKey: 'p', status: 'pending', creditAwarded: false });
    expect(errOf(await adminCreateCatalogAlbum(admin, { artistId: String(pending._id), title: 'T' })).code).toBe('CATALOG_PARENT_NOT_APPROVED');
    const { artist } = (await adminCreateCatalogArtist(admin, { name: 'Q' })) as { artist: any };
    const r = (await adminCreateCatalogAlbum(admin, { artistId: String(artist._id), title: 'Debut', year: '1993', coverUrl: img('other-user') })) as { album: any };
    expect(r.album.status).toBe('approved');
    expect(r.album.source).toBe('admin');
    expect(r.album.slug).toBe('debut');
    expect(errOf(await adminCreateCatalogAlbum(admin, { artistId: String(artist._id), title: 'debut' })).code).toBe('CATALOG_DUPLICATE');
    expect(errOf(await adminCreateCatalogAlbum(admin, { artistId: String(artist._id), title: 'Z', year: '93' })).code).toBe('CATALOG_INVALID_INPUT');
  });
});

describe('admin catalog update', () => {
  it('keeps the slug when the name changes and re-derives nameKey', async () => {
    const admin = await seedUser();
    const { artist } = (await adminCreateCatalogArtist(admin, { name: 'Old Name' })) as { artist: any };
    const r = (await adminUpdateCatalogEntry(admin, 'artist', String(artist._id), { name: 'New Name' })) as { artist: any };
    expect(r.artist.slug).toBe('old-name');
    expect(r.artist.name).toBe('New Name');
    expect(r.artist.nameKey).not.toBe(artist.nameKey);
  });

  it('re-runs the homonym rule on rename', async () => {
    const admin = await seedUser();
    await adminCreateCatalogArtist(admin, { name: 'Taken' });
    const { artist } = (await adminCreateCatalogArtist(admin, { name: 'Other' })) as { artist: any };
    const refused = errOf(await adminUpdateCatalogEntry(admin, 'artist', String(artist._id), { name: 'Taken' }));
    expect(refused.code).toBe('CATALOG_DISAMBIGUATION_REQUIRED');
    const ok = await adminUpdateCatalogEntry(admin, 'artist', String(artist._id), { name: 'Taken', disambiguation: 'second' });
    expect('artist' in ok).toBe(true);
  });

  it('edits fields of a pending community entry without changing status or slug', async () => {
    const admin = await seedUser();
    const u = await seedUser({}, []);
    const pending = await seedCommunity(CatalogArtist, u, { name: 'P', nameKey: 'p', status: 'pending', creditAwarded: false });
    const r = (await adminUpdateCatalogEntry(admin, 'artist', String(pending._id), { bio: 'fixed', ...({ status: 'approved', slug: 'hack' } as object) })) as { artist: any };
    expect(r.artist.bio).toBe('fixed');
    expect(r.artist.status).toBe('pending');
    expect(r.artist.slug).toBeNull();
  });

  it('updates albums and validates year, cover and duplicates', async () => {
    const admin = await seedUser();
    const { artist } = (await adminCreateCatalogArtist(admin, { name: 'Q' })) as { artist: any };
    const a1 = (await adminCreateCatalogAlbum(admin, { artistId: String(artist._id), title: 'One' })) as { album: any };
    await adminCreateCatalogAlbum(admin, { artistId: String(artist._id), title: 'Two' });
    const id = String(a1.album._id);
    expect(errOf(await adminUpdateCatalogEntry(admin, 'album', id, { coverUrl: 'http://x.test/a.png' })).code).toBe('CATALOG_INVALID_IMAGE');
    expect(errOf(await adminUpdateCatalogEntry(admin, 'album', id, { title: 'two' })).code).toBe('CATALOG_DUPLICATE');
    const r = (await adminUpdateCatalogEntry(admin, 'album', id, { title: 'Uno', year: '2000' })) as { album: any };
    expect(r.album.slug).toBe('one');
    expect(r.album.year).toBe('2000');
  });

  it('refuses non-managers and unknown ids', async () => {
    const plain = await seedUser({}, []);
    const admin = await seedUser();
    const id = String(new mongoose.Types.ObjectId());
    expect(errOf(await adminUpdateCatalogEntry(plain, 'artist', id, { bio: 'x' })).code).toBe('CATALOG_FORBIDDEN');
    expect(errOf(await adminUpdateCatalogEntry(admin, 'artist', id, { bio: 'x' })).code).toBe('CATALOG_NOT_FOUND');
  });
});

describe('admin catalog delete', () => {
  const setup = async () => {
    const admin = await seedUser();
    const u = await seedUser({}, []);
    const artist = await seedCommunity(CatalogArtist, u, { name: 'A', nameKey: 'a', slug: 'a' });
    const approved = await seedCommunity(CatalogAlbum, u, { artistId: artist._id, title: 'X', titleKey: 'x', slug: 'x' });
    const pending = await seedCommunity(CatalogAlbum, u, { artistId: artist._id, title: 'Y', titleKey: 'y', status: 'pending', creditAwarded: false });
    const rejected = await seedCommunity(CatalogAlbum, u, { artistId: artist._id, title: 'Z', titleKey: 'z', status: 'rejected', creditAwarded: false });
    return { admin, u, artist, approved, pending, rejected };
  };

  it('cascades to all albums of any status and revokes each awarded credit once', async () => {
    const { admin, u, artist } = await setup();
    const r = await adminDeleteCatalogEntry(admin, 'artist', String(artist._id), { revokeCredit: true });
    expect(r).toEqual({ ok: true });
    expect(await CatalogArtist.countDocuments()).toBe(0);
    expect(await CatalogAlbum.countDocuments()).toBe(0);
    expect(revokeCatalogCredit.mock.calls).toEqual([[u, 'artist'], [u, 'album']]);
  });

  it('does not revoke without the flag or without awarded credit', async () => {
    const { admin, artist, approved } = await setup();
    await adminDeleteCatalogEntry(admin, 'album', String(approved._id), { revokeCredit: false });
    expect(revokeCatalogCredit).not.toHaveBeenCalled();
    await CatalogArtist.updateOne({ _id: artist._id }, { creditAwarded: false });
    await adminDeleteCatalogEntry(admin, 'artist', String(artist._id), { revokeCredit: true });
    expect(revokeCatalogCredit).not.toHaveBeenCalled();
  });

  it('is idempotent: a second delete finds nothing and revokes nothing more', async () => {
    const { admin, approved } = await setup();
    await adminDeleteCatalogEntry(admin, 'album', String(approved._id), { revokeCredit: true });
    expect(errOf(await adminDeleteCatalogEntry(admin, 'album', String(approved._id), { revokeCredit: true })).code).toBe('CATALOG_NOT_FOUND');
    expect(revokeCatalogCredit).toHaveBeenCalledTimes(1);
  });

  it('keeps the entry and its credit flag when revocation throws', async () => {
    const { admin, approved } = await setup();
    revokeCatalogCredit.mockRejectedValueOnce(new Error('boom'));
    await expect(adminDeleteCatalogEntry(admin, 'album', String(approved._id), { revokeCredit: true })).rejects.toThrow('boom');
    const still = await CatalogAlbum.findById(approved._id);
    expect(still?.creditAwarded).toBe(true);
  });

  it('refuses non-managers', async () => {
    const { artist } = await setup();
    const plain = await seedUser({}, []);
    expect(errOf(await adminDeleteCatalogEntry(plain, 'artist', String(artist._id), { revokeCredit: false })).code).toBe('CATALOG_FORBIDDEN');
    expect(await CatalogArtist.countDocuments()).toBe(1);
  });

  it.todo('decrements the submitter counters and XP once (needs Task 7 revoke)');
});

describe('admin audit log', () => {
  it('records create, update and delete', async () => {
    const admin = await seedUser();
    const { artist } = (await adminCreateCatalogArtist(admin, { name: 'Logged' })) as { artist: any };
    await adminUpdateCatalogEntry(admin, 'artist', String(artist._id), { bio: 'b' });
    await adminDeleteCatalogEntry(admin, 'artist', String(artist._id), { revokeCredit: false });
    const logs = await AdminLog.find({}).sort({ createdAt: 1 }).lean();
    expect(logs.map((l) => l.action)).toEqual(['catalog.create', 'catalog.update', 'catalog.delete']);
    expect(String(logs[0].adminId)).toBe(admin);
    expect(JSON.parse(logs[2].details as string)).toMatchObject({ kind: 'artist', name: 'Logged', revokeCredit: false });
  });
});
