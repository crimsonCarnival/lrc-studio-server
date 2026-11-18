import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from '../users/user.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import CatalogSubmissionLog from './catalog-submission-log.model.js';
import {
  submitCatalogArtist,
  submitCatalogAlbum,
  updateMyPendingEntry,
  withdrawMyPendingEntry,
  listMySubmissions,
} from './catalog.service.js';
import { CATALOG_LIMITS } from './catalog.limits.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), CatalogArtist.init(), CatalogAlbum.init(), CatalogSubmissionLog.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'democloud');
  await Promise.all([User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}), CatalogSubmissionLog.deleteMany({})]);
});

let seq = 0;
const seedUser = async (isVerified = true, permissions: string[] = []): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `u${n}`, email: `u${n}@x.test`, passwordHash: 'x', isVerified, permissions,
  });
  return insertedId.toString();
};
const errOf = (r: object) => r as { error: string; status: number; code: string; existing?: unknown };

describe('catalog submissions', () => {
  it('refuses unverified users', async () => {
    const u = await seedUser(false);
    const r = errOf(await submitCatalogArtist(u, { name: 'Björk' }));
    expect(r.code).toBe('CATALOG_UNVERIFIED');
    expect(r.status).toBe(403);
  });

  it('creates a pending, slugless community artist', async () => {
    const u = await seedUser();
    const r = await submitCatalogArtist(u, { name: '  Björk  ', bio: 'hi' });
    if (!('artist' in r)) throw new Error('expected artist');
    expect(r.artist.status).toBe('pending');
    expect(r.artist.source).toBe('community');
    expect(r.artist.slug).toBeNull();
    expect(r.artist.name).toBe('Björk');
    expect(r.artist.nameKey).toBe('björk');
  });

  it('rate limits the 11th submission within 24h', async () => {
    const u = await seedUser();
    await CatalogSubmissionLog.insertMany(Array.from({ length: CATALOG_LIMITS.maxPerDay }, () => ({ userId: u, at: new Date() })));
    const r = errOf(await submitCatalogArtist(u, { name: 'One too many' }));
    expect(r.code).toBe('CATALOG_RATE_LIMITED');
    expect(r.status).toBe(429);
  });

  it('ignores log rows older than 24h', async () => {
    const u = await seedUser();
    const old = new Date(Date.now() - 25 * 3600_000);
    await CatalogSubmissionLog.insertMany(Array.from({ length: 12 }, () => ({ userId: u, at: old })));
    expect('artist' in (await submitCatalogArtist(u, { name: 'Fresh' }))).toBe(true);
  });

  it('submit/withdraw cycling cannot escape the daily cap', async () => {
    const u = await seedUser();
    for (let i = 0; i < CATALOG_LIMITS.maxPerDay; i++) {
      const r = await submitCatalogArtist(u, { name: `Cycle ${i}` });
      if (!('artist' in r)) throw new Error(`expected artist at ${i}`);
      expect(await withdrawMyPendingEntry(u, 'artist', String(r.artist._id))).toEqual({ ok: true });
    }
    expect(errOf(await submitCatalogArtist(u, { name: 'Cycle 11' })).code).toBe('CATALOG_RATE_LIMITED');
  });

  it('concurrent submits at 4 pending: exactly one succeeds', async () => {
    const u = await seedUser();
    for (let i = 0; i < 4; i++) await submitCatalogArtist(u, { name: `Seed ${i}` });
    const results = await Promise.all([submitCatalogArtist(u, { name: 'Race A' }), submitCatalogArtist(u, { name: 'Race B' })]);
    expect(results.filter((r) => 'artist' in r)).toHaveLength(1);
    expect(results.map((r) => ('code' in r ? r.code : null)).filter(Boolean)).toEqual(['CATALOG_PENDING_CAP']);
    expect(await CatalogArtist.countDocuments({ submittedBy: u, status: 'pending' })).toBe(5);
  });

  it('strips markup from names; empty after strip or non-string is invalid', async () => {
    const u = await seedUser();
    const ok = await submitCatalogArtist(u, { name: '<b>Name</b>' });
    if (!('artist' in ok)) throw new Error('expected artist');
    expect(ok.artist.name).toBe('Name');
    expect(errOf(await submitCatalogArtist(u, { name: '<img onerror=x>' })).code).toBe('CATALOG_INVALID_INPUT');
    expect(errOf(await submitCatalogArtist(u, { name: { $ne: null } as unknown as string })).code).toBe('CATALOG_INVALID_INPUT');
  });

  it('year must be four digits', async () => {
    const u = await seedUser();
    const p = await CatalogArtist.create({ name: 'P', nameKey: 'p', status: 'approved', slug: 'p', source: 'admin', submittedBy: u });
    expect(errOf(await submitCatalogAlbum(u, { artistId: String(p._id), title: 'T', year: 'abcd' })).code).toBe('CATALOG_INVALID_INPUT');
    expect(errOf(await submitCatalogAlbum(u, { artistId: String(p._id), title: 'T', year: '99' })).code).toBe('CATALOG_INVALID_INPUT');
  });

  it("own pending duplicate is revealed even when another user's older pending shares the key", async () => {
    const u = await seedUser();
    const other = await seedUser();
    await CatalogArtist.create({ name: 'Shared', nameKey: 'shared', status: 'pending', source: 'community', submittedBy: other });
    // Seed my own pending directly: a normal submit would be refused as a duplicate of the other's.
    const mine = await CatalogArtist.create({ name: 'Shared', nameKey: 'shared', status: 'pending', source: 'community', submittedBy: u });
    const dup = errOf(await submitCatalogArtist(u, { name: 'SHARED' }));
    expect(dup.code).toBe('CATALOG_DUPLICATE');
    expect(String((dup.existing as { id: unknown }).id)).toBe(String(mine._id));
  });

  it('caps pending at 5 across artists and albums; withdrawing frees a slot', async () => {
    const u = await seedUser();
    const owner = await seedUser();
    const parent = await CatalogArtist.create({
      name: 'P', nameKey: 'p', status: 'approved', slug: 'p', source: 'admin', submittedBy: owner,
    });
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await submitCatalogArtist(u, { name: `Artist ${i}` });
      if (!('artist' in r)) throw new Error('expected artist');
      made.push(String(r.artist._id));
    }
    for (let i = 0; i < 2; i++) {
      const r = await submitCatalogAlbum(u, { artistId: String(parent._id), title: `Album ${i}` });
      expect('album' in r).toBe(true);
    }
    const blocked = errOf(await submitCatalogArtist(u, { name: 'Sixth' }));
    expect(blocked.code).toBe('CATALOG_PENDING_CAP');
    expect(blocked.status).toBe(429);
    expect(await withdrawMyPendingEntry(u, 'artist', made[0])).toEqual({ ok: true });
    expect('artist' in (await submitCatalogArtist(u, { name: 'Sixth' }))).toBe(true);
  });

  it('rejects a duplicate nameKey against approved and pending', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const a = await CatalogArtist.create({
      name: 'Björk', nameKey: 'björk', status: 'approved', slug: 'bjork', source: 'admin', submittedBy: other,
    });
    const dupApproved = errOf(await submitCatalogArtist(u, { name: 'BJÖRK' }));
    expect(dupApproved.code).toBe('CATALOG_DUPLICATE');
    expect(dupApproved.status).toBe(409);
    expect(dupApproved.existing).toMatchObject({ slug: 'bjork', name: 'Björk' });
    expect(String((dupApproved.existing as { id: unknown }).id)).toBe(String(a._id));

    // NFC vs NFD input normalises to the same key.
    const nfd = errOf(await submitCatalogArtist(u, { name: 'Bjo\u0308rk' }));
    expect(nfd.code).toBe('CATALOG_DUPLICATE');

    await CatalogArtist.create({
      name: 'Sigur Rós', nameKey: 'sigur rós', status: 'pending', source: 'community', submittedBy: other,
    });
    const dupOther = errOf(await submitCatalogArtist(u, { name: 'sigur rós' }));
    expect(dupOther.code).toBe('CATALOG_DUPLICATE');
    expect(dupOther.existing).toBeUndefined();

    const mine = await submitCatalogArtist(u, { name: 'Mine' });
    if (!('artist' in mine)) throw new Error('expected artist');
    const dupMine = errOf(await submitCatalogArtist(u, { name: 'MINE' }));
    expect(dupMine.code).toBe('CATALOG_DUPLICATE');
    expect(String((dupMine.existing as { id: unknown }).id)).toBe(String(mine.artist._id));
  });

  it('bio is stripped of tags and capped at 1000', async () => {
    const u = await seedUser();
    const r = await submitCatalogArtist(u, { name: 'Tagged', bio: '<b>Hello</b><script>alert(1)</script> world' });
    if (!('artist' in r)) throw new Error('expected artist');
    expect(r.artist.bio).toBe('Hello world');
    const long = errOf(await submitCatalogArtist(u, { name: 'Long', bio: 'x'.repeat(1001) }));
    expect(long.code).toBe('CATALOG_INVALID_INPUT');
    expect(long.status).toBe(400);
    // Length is checked after sanitizing: markup does not count against the cap.
    const ok = await submitCatalogArtist(u, { name: 'Padded', bio: `<b>${'x'.repeat(1000)}</b>` });
    expect('artist' in ok).toBe(true);
  });

  it('name over 300 chars is refused; empty is refused', async () => {
    const u = await seedUser();
    expect(errOf(await submitCatalogArtist(u, { name: 'x'.repeat(301) })).code).toBe('CATALOG_INVALID_INPUT');
    expect(errOf(await submitCatalogArtist(u, { name: '   ' })).code).toBe('CATALOG_INVALID_INPUT');
  });

  it('imageUrl from another host or another user is refused; own catalog image is accepted', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const bad = errOf(await submitCatalogArtist(u, { name: 'A', imageUrl: 'https://evil.example/x.png' }));
    expect(bad.code).toBe('CATALOG_INVALID_IMAGE');
    expect(bad.status).toBe(422);
    const theirs = `https://res.cloudinary.com/democloud/image/upload/catalog/${other}/a.png`;
    expect(errOf(await submitCatalogArtist(u, { name: 'B', imageUrl: theirs })).code).toBe('CATALOG_INVALID_IMAGE');
    const mine = `https://res.cloudinary.com/democloud/image/upload/catalog/${u}/a.png`;
    const r = await submitCatalogArtist(u, { name: 'C', imageUrl: mine });
    if (!('artist' in r)) throw new Error('expected artist');
    expect(r.artist.imageUrl).toBe(mine);
  });

  it('album needs an approved parent', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const mk = (status: string) =>
      CatalogArtist.create({ name: status, nameKey: status, status, source: 'community', submittedBy: other });
    for (const status of ['pending', 'rejected']) {
      const p = await mk(status);
      const r = errOf(await submitCatalogAlbum(u, { artistId: String(p._id), title: 'X' }));
      expect(r.code).toBe('CATALOG_PARENT_NOT_APPROVED');
      expect(r.status).toBe(422);
    }
    const missing = errOf(await submitCatalogAlbum(u, { artistId: String(new mongoose.Types.ObjectId()), title: 'X' }));
    expect(missing.code).toBe('CATALOG_PARENT_NOT_APPROVED');
    const garbage = errOf(await submitCatalogAlbum(u, { artistId: 'nope', title: 'X' }));
    expect(garbage.code).toBe('CATALOG_PARENT_NOT_APPROVED');
  });

  it('album validates title, year and cover', async () => {
    const u = await seedUser();
    const p = await CatalogArtist.create({ name: 'P', nameKey: 'p', status: 'approved', slug: 'p', source: 'admin', submittedBy: u });
    const id = String(p._id);
    expect(errOf(await submitCatalogAlbum(u, { artistId: id, title: 'x'.repeat(501) })).code).toBe('CATALOG_INVALID_INPUT');
    expect(errOf(await submitCatalogAlbum(u, { artistId: id, title: 'T', year: '19999' })).code).toBe('CATALOG_INVALID_INPUT');
    expect(errOf(await submitCatalogAlbum(u, { artistId: id, title: 'T', coverUrl: 'https://evil.example/c.png' })).code).toBe('CATALOG_INVALID_IMAGE');
    const ok = await submitCatalogAlbum(u, { artistId: id, title: 'T', year: '1997' });
    if (!('album' in ok)) throw new Error('expected album');
    expect(ok.album.year).toBe('1997');
    expect(ok.album.slug).toBeNull();
  });

  it('album duplicate is per artist and titleKey', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const a1 = await CatalogArtist.create({ name: 'A1', nameKey: 'a1', status: 'approved', slug: 'a1', source: 'admin', submittedBy: other });
    const a2 = await CatalogArtist.create({ name: 'A2', nameKey: 'a2', status: 'approved', slug: 'a2', source: 'admin', submittedBy: other });
    const alb = await CatalogAlbum.create({
      artistId: a1._id, title: 'Homogenic', titleKey: 'homogenic', status: 'approved', slug: 'homogenic', source: 'admin', submittedBy: other,
    });
    const dup = errOf(await submitCatalogAlbum(u, { artistId: String(a1._id), title: 'HOMOGENIC' }));
    expect(dup.code).toBe('CATALOG_DUPLICATE');
    expect(dup.existing).toMatchObject({ slug: 'homogenic' });
    expect(String((dup.existing as { id: unknown }).id)).toBe(String(alb._id));
    expect('album' in (await submitCatalogAlbum(u, { artistId: String(a2._id), title: 'Homogenic' }))).toBe(true);
  });

  it("a user cannot read, edit or withdraw another user's entry", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const r = await submitCatalogArtist(owner, { name: 'Private' });
    if (!('artist' in r)) throw new Error('expected artist');
    const id = String(r.artist._id);
    expect(errOf(await updateMyPendingEntry(intruder, 'artist', id, { name: 'Hax' })).code).toBe('CATALOG_NOT_FOUND');
    expect(errOf(await withdrawMyPendingEntry(intruder, 'artist', id)).status).toBe(404);
    expect(errOf(await withdrawMyPendingEntry(intruder, 'artist', 'not-an-id')).status).toBe(404);
    const listed = await listMySubmissions(intruder);
    expect(listed.artists).toHaveLength(0);
    expect(await CatalogArtist.countDocuments({ _id: id })).toBe(1);
  });

  it('edit and withdraw work only while pending', async () => {
    const u = await seedUser();
    const r = await submitCatalogArtist(u, { name: 'Edit Me' });
    if (!('artist' in r)) throw new Error('expected artist');
    const id = String(r.artist._id);
    const upd = await updateMyPendingEntry(u, 'artist', id, { name: 'Edited', bio: '<i>new</i>' });
    if (!('artist' in upd)) throw new Error('expected artist');
    expect(upd.artist.name).toBe('Edited');
    expect(upd.artist.nameKey).toBe('edited');
    expect(upd.artist.bio).toBe('new');

    await CatalogArtist.updateOne({ _id: id }, { status: 'rejected', reviewNote: 'nope' });
    const e1 = errOf(await updateMyPendingEntry(u, 'artist', id, { name: 'Again' }));
    expect(e1.code).toBe('CATALOG_NOT_FOUND');
    const e2 = errOf(await withdrawMyPendingEntry(u, 'artist', id));
    expect(e2.code).toBe('CATALOG_NOT_FOUND');
    expect(await CatalogArtist.countDocuments({ _id: id })).toBe(1);
  });

  it('editing into a duplicate name is refused (own entry excluded from the check)', async () => {
    const u = await seedUser();
    const other = await seedUser();
    await CatalogArtist.create({ name: 'Taken', nameKey: 'taken', status: 'approved', slug: 'taken', source: 'admin', submittedBy: other });
    const r = await submitCatalogArtist(u, { name: 'Mine' });
    if (!('artist' in r)) throw new Error('expected artist');
    const id = String(r.artist._id);
    expect(errOf(await updateMyPendingEntry(u, 'artist', id, { name: 'TAKEN' })).code).toBe('CATALOG_DUPLICATE');
    const same = await updateMyPendingEntry(u, 'artist', id, { name: 'MINE' });
    expect('artist' in same).toBe(true);
  });

  it('album edit and withdraw', async () => {
    const u = await seedUser();
    const p = await CatalogArtist.create({ name: 'P', nameKey: 'p', status: 'approved', slug: 'p', source: 'admin', submittedBy: u });
    const r = await submitCatalogAlbum(u, { artistId: String(p._id), title: 'Old' });
    if (!('album' in r)) throw new Error('expected album');
    const id = String(r.album._id);
    const upd = await updateMyPendingEntry(u, 'album', id, { title: 'New', year: '2001' });
    if (!('album' in upd)) throw new Error('expected album');
    expect(upd.album.titleKey).toBe('new');
    expect(upd.album.year).toBe('2001');
    expect(await withdrawMyPendingEntry(u, 'album', id)).toEqual({ ok: true });
    expect(await CatalogAlbum.countDocuments({})).toBe(0);
  });

  it('lists my submissions newest first with reviewNote, all statuses', async () => {
    const u = await seedUser();
    const first = await submitCatalogArtist(u, { name: 'First' });
    const second = await submitCatalogArtist(u, { name: 'Second' });
    if (!('artist' in first) || !('artist' in second)) throw new Error('expected artists');
    await CatalogArtist.updateOne({ _id: first.artist._id }, { status: 'rejected', reviewNote: 'too vague' });
    const { artists, albums } = await listMySubmissions(u);
    expect(artists.map((a) => a.name)).toEqual(['Second', 'First']);
    expect(artists[1].reviewNote).toBe('too vague');
    expect(albums).toEqual([]);
  });

  describe('submission source', () => {
    it('a submitter holding catalog.manage creates admin-source artists and albums', async () => {
      const u = await seedUser(true, ['catalog.manage']);
      const r = await submitCatalogArtist(u, { name: 'Staff Artist' });
      if (!('artist' in r)) throw new Error('expected artist');
      expect(r.artist.source).toBe('admin');
      expect(r.artist.status).toBe('pending');
      expect(r.artist.slug).toBeNull();
      const parent = await CatalogArtist.create({
        name: 'Parent', nameKey: 'parent', slug: 'parent', status: 'approved', source: 'community', submittedBy: u,
      });
      const a = await submitCatalogAlbum(u, { artistId: String(parent._id), title: 'Staff Album' });
      if (!('album' in a)) throw new Error('expected album');
      expect(a.album.source).toBe('admin');
      expect(a.album.status).toBe('pending');
      expect(a.album.slug).toBeNull();
    });

    it('a catalog.review-only submitter stays community', async () => {
      const u = await seedUser(true, ['catalog.review']);
      const r = await submitCatalogArtist(u, { name: 'Reviewer Artist' });
      if (!('artist' in r)) throw new Error('expected artist');
      expect(r.artist.source).toBe('community');
    });

    it('permission is read from the DB at submit time', async () => {
      const u = await seedUser();
      await User.updateOne({ _id: u }, { $set: { permissions: ['catalog.manage'] } });
      const r = await submitCatalogArtist(u, { name: 'Promoted' });
      if (!('artist' in r)) throw new Error('expected artist');
      expect(r.artist.source).toBe('admin');
    });

    it('staff submissions still count against the caps', async () => {
      const u = await seedUser(true, ['catalog.manage']);
      for (let i = 0; i < CATALOG_LIMITS.maxPending; i++) {
        const ok = await submitCatalogArtist(u, { name: `Staff ${i}` });
        expect('artist' in ok).toBe(true);
      }
      const r = errOf(await submitCatalogArtist(u, { name: 'Staff overflow' }));
      expect(r.code).toBe('CATALOG_PENDING_CAP');
    });
  });
});
