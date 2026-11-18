import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../../modules/badges/badge.service.js', () => ({ triggerBadgeCheck: async () => [] }));
vi.mock('../../modules/catalog/catalog.rewards.js', () => ({ awardCatalogCredit: async () => undefined, revokeCatalogCredit: async () => undefined }));

import User from '../../modules/users/user.model.js';
import CatalogArtist from '../../modules/catalog/catalog-artist.model.js';
import CatalogAlbum from '../../modules/catalog/catalog-album.model.js';
import Project from '../../modules/projects/project.model.js';
import CatalogAlbumDismissal from '../../modules/catalog/catalog-album-dismissal.model.js';
import CatalogSubmissionLog from '../../modules/catalog/catalog-submission-log.model.js';
import Notification from '../../modules/notifications/notification.model.js';
import { catalogResolvers } from './catalog.resolvers.js';
import { deriveErrorCode } from '../error-code.js';
import type { Context } from './context.js';

let repl: MongoMemoryReplSet;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), CatalogArtist.init(), CatalogAlbum.init(), Notification.init(), CatalogAlbumDismissal.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}),
    CatalogSubmissionLog.deleteMany({}), Notification.deleteMany({}),
    CatalogAlbumDismissal.deleteMany({}), Project.collection.deleteMany({}),
  ]);
});

let seq = 0;
const seedUser = async (permissions: string[] = [], verified = true): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `c${n}`, email: `c${n}@x.test`, passwordHash: 'x', isVerified: verified, permissions,
  });
  return insertedId.toString();
};
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ userId, ...extra } as Context);

type Fn = (root: unknown, args: any, context: Context) => Promise<any>;
const Q = catalogResolvers.Query as unknown as Record<string, Fn>;
const M = catalogResolvers.Mutation as unknown as Record<string, Fn>;
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return deriveErrorCode(e);
  }
  return 'no-error';
};

describe('catalog resolvers', () => {
  it('anonymous callers get unauthorized, banned-only identity does not count', async () => {
    expect(await codeOf(Q.myCatalogSubmissions({}, {}, ctx()))).toBe('unauthorized');
    expect(await codeOf(Q.catalogReviewQueue({}, {}, ctx()))).toBe('unauthorized');
    expect(await codeOf(M.submitCatalogArtist({}, { name: 'X' }, ctx()))).toBe('unauthorized');
    expect(await codeOf(M.submitCatalogArtist({}, { name: 'X' }, ctx(undefined, { bannedUserId: await seedUser() })))).toBe('unauthorized');
  });

  it('myCatalogSubmissions returns only the caller rows', async () => {
    const a = await seedUser();
    const b = await seedUser();
    await M.submitCatalogArtist({}, { name: 'Mine' }, ctx(a));
    await M.submitCatalogArtist({}, { name: 'Theirs' }, ctx(b));
    const r = await Q.myCatalogSubmissions({}, {}, ctx(a));
    expect(r.artists.map((x: { name: string }) => x.name)).toEqual(['Mine']);
    expect(r.albums).toEqual([]);
  });

  it('catalogReviewQueue: plain user forbidden, reviewer gets oldest first with submitter', async () => {
    const u = await seedUser();
    const rev = await seedUser(['catalog.review']);
    const s = await seedUser();
    expect(await codeOf(Q.catalogReviewQueue({}, {}, ctx(u)))).toBe('forbidden');
    await CatalogArtist.create({ name: 'New', nameKey: 'new', status: 'pending', source: 'community', submittedBy: s, createdAt: new Date('2026-02-01') });
    await CatalogArtist.create({ name: 'Old', nameKey: 'old', status: 'pending', source: 'community', submittedBy: s, createdAt: new Date('2026-01-01') });
    await CatalogArtist.create({ name: 'Done', nameKey: 'done', status: 'approved', slug: 'done', source: 'community', submittedBy: s });
    const q = await Q.catalogReviewQueue({}, {}, ctx(rev));
    expect(q.artists.map((x: { name: string }) => x.name)).toEqual(['Old', 'New']);
    const sub = await catalogResolvers.CatalogArtist.submittedBy(q.artists[0]);
    expect(sub).toMatchObject({ id: s, accountName: expect.any(String) });
  });

  it('adminDeleteCatalogEntry needs sudo', async () => {
    const admin = await seedUser(['catalog.manage']);
    const a = await CatalogArtist.create({ name: 'Z', nameKey: 'z', status: 'approved', slug: 'z', source: 'admin', submittedBy: admin });
    expect(await codeOf(M.adminDeleteCatalogEntry({}, { kind: 'artist', id: String(a._id) }, ctx(admin)))).toBe('SUDO_REQUIRED');
    expect(await CatalogArtist.countDocuments()).toBe(1);
    expect(await M.adminDeleteCatalogEntry({}, { kind: 'artist', id: String(a._id), revokeCredit: false }, ctx(admin, { hasSudo: true }))).toBe(true);
    expect(await CatalogArtist.countDocuments()).toBe(0);
  });

  it('adminDeleteCatalogEntry without catalog.manage is forbidden even with sudo', async () => {
    const u = await seedUser();
    expect(await codeOf(M.adminDeleteCatalogEntry({}, { kind: 'artist', id: String(new mongoose.Types.ObjectId()) }, ctx(u, { hasSudo: true })))).toBe('forbidden');
  });

  it('submit -> review -> myCatalogSubmissions shows approved with slug', async () => {
    const s = await seedUser();
    const rev = await seedUser(['catalog.review']);
    const created = await M.submitCatalogArtist({}, { name: 'Björk' }, ctx(s));
    expect(created).toMatchObject({ status: 'pending', slug: null });
    expect(await M.reviewCatalogEntry({}, { kind: 'artist', id: created.id, decision: 'approve' }, ctx(rev))).toBe(true);
    const mine = await Q.myCatalogSubmissions({}, {}, ctx(s));
    expect(mine.artists[0]).toMatchObject({ status: 'approved', slug: 'bjork' });
  });

  it('a failing review throws with a lower-cased service code', async () => {
    const rev = await seedUser(['catalog.review']);
    const c = await M.submitCatalogArtist({}, { name: 'Self' }, ctx(await seedUser()));
    expect(await codeOf(M.reviewCatalogEntry({}, { kind: 'artist', id: c.id, decision: 'approve' }, ctx(rev)))).toBe('no-error');
    expect(await codeOf(M.reviewCatalogEntry({}, { kind: 'artist', id: c.id, decision: 'approve' }, ctx(rev)))).toBe('catalog_already_reviewed');
  });

  it('review with a stale expectedUpdatedAt maps to catalog_changed', async () => {
    const rev = await seedUser(['catalog.review']);
    const c = await M.submitCatalogArtist({}, { name: 'Edited' }, ctx(await seedUser()));
    expect(await codeOf(M.reviewCatalogEntry({}, { kind: 'artist', id: c.id, decision: 'approve', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, ctx(rev)))).toBe('catalog_changed');
  });

  it('duplicate error carries the existing entry in extensions', async () => {
    const s = await seedUser();
    await M.submitCatalogArtist({}, { name: 'Dup' }, ctx(s));
    try {
      await M.submitCatalogArtist({}, { name: 'Dup' }, ctx(s));
      expect.unreachable();
    } catch (e) {
      const ext = (e as { extensions: { code: string; existing?: { name: string } } }).extensions;
      expect(ext.code).toBe('catalog_duplicate');
      expect(ext.existing).toMatchObject({ name: 'Dup' });
    }
  });

  it('catalogAdminArtists lists approved only and clamps paging; needs catalog.manage', async () => {
    const admin = await seedUser(['catalog.manage']);
    expect(await codeOf(Q.catalogAdminArtists({}, {}, ctx(await seedUser())))).toBe('forbidden');
    await CatalogArtist.create({ name: 'Alpha', nameKey: 'alpha', status: 'approved', slug: 'alpha', source: 'admin', submittedBy: admin });
    await CatalogArtist.create({ name: 'Beta', nameKey: 'beta', status: 'pending', source: 'community', submittedBy: admin });
    const r = await Q.catalogAdminArtists({}, { limit: 9999, offset: -5 }, ctx(admin));
    expect(r.map((x: { name: string }) => x.name)).toEqual(['Alpha']);
    const f = await Q.catalogAdminArtists({}, { query: 'alp' }, ctx(admin));
    expect(f).toHaveLength(1);
  });

  it('exposes updatedAt as an ISO string', () => {
    const d = new Date('2026-03-04T05:06:07.000Z');
    expect(catalogResolvers.CatalogArtist.updatedAt({ updatedAt: d })).toBe(d.toISOString());
    expect(catalogResolvers.CatalogAlbum.createdAt({ createdAt: d })).toBe(d.toISOString());
  });

  it('catalogArtist is public, approved-only, and hides reviewer fields', async () => {
    const s = await seedUser();
    const a = await CatalogArtist.create({ name: 'Pub', nameKey: 'pub', status: 'approved', slug: 'pub', source: 'community', submittedBy: s, reviewNote: 'internal' });
    await CatalogArtist.create({ name: 'Pend', nameKey: 'pend', status: 'pending', source: 'community', submittedBy: s });
    await CatalogAlbum.create({ artistId: a._id, title: 'Yes', titleKey: 'yes', status: 'approved', slug: 'yes', source: 'community', submittedBy: s });
    await CatalogAlbum.create({ artistId: a._id, title: 'No', titleKey: 'no', status: 'pending', source: 'community', submittedBy: s });
    const page = await Q.catalogArtist({}, { slug: 'PUB' }, ctx());
    expect(page.artist.name).toBe('Pub');
    expect(page.artist.reviewNote).toBeUndefined();
    expect(page.artist.submittedBy).toBeUndefined();
    expect(page.albums.map((x: { title: string }) => x.title)).toEqual(['Yes']);
    expect(page.songs).toEqual([]);
    expect(await Q.catalogArtist({}, { slug: 'pend' }, ctx())).toBeNull();
    expect(await Q.catalogArtist({}, { slug: 'nope' }, ctx())).toBeNull();
  });

  it('adminUpdateCatalogEntry passes imageSource and imageSourceUrl', async () => {
    const admin = await seedUser(['catalog.manage']);
    const a = await CatalogArtist.create({ name: 'Cr', nameKey: 'cr', status: 'approved', slug: 'cr', source: 'admin', submittedBy: admin });
    const url = 'https://genius.com/artists/Cr';
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'democloud');
    const imageUrl = 'https://res.cloudinary.com/democloud/image/upload/v1/catalog/x/p.webp';
    await M.adminUpdateCatalogEntry({}, { kind: 'artist', id: String(a._id), imageUrl, imageSource: 'genius', imageSourceUrl: url }, ctx(admin));
    const row = await CatalogArtist.findById(a._id).lean();
    expect(row?.imageSource).toBe('genius');
    expect(row?.imageSourceUrl).toBe(url);
  });

  it('catalogArtist exposes imageSource and imageSourceUrl publicly', async () => {
    const s = await seedUser();
    await CatalogArtist.create({
      name: 'Cr2', nameKey: 'cr2', status: 'approved', slug: 'cr2', source: 'admin', submittedBy: s,
      imageUrl: 'https://x.test/p.webp', imageSource: 'genius', imageSourceUrl: 'https://genius.com/artists/Cr2',
    });
    const page = await Q.catalogArtist({}, { slug: 'cr2' }, ctx());
    expect(page.artist.imageSource).toBe('genius');
    expect(page.artist.imageSourceUrl).toBe('https://genius.com/artists/Cr2');
  });
  describe('album detection', () => {
    const seedDetect = async (admin: string) => {
      const a = await CatalogArtist.create({ name: 'Bjork', nameKey: 'bjork', status: 'approved', slug: 'bjork', source: 'admin', submittedBy: admin });
      for (let i = 0; i < 2; i++) {
        await Project.collection.insertOne({
          publicId: `dp${++seq}`, userId: new mongoose.Types.ObjectId(), title: 't', kind: 'song', public: false,
          metadata: { artists: [{ name: 'Bjork', role: 'primary' }], songAlbum: 'Homogenic', songYear: '1997' },
        });
      }
      return String(a._id);
    };

    it('anonymous callers get unauthorized', async () => {
      const id = String(new mongoose.Types.ObjectId());
      expect(await codeOf(Q.catalogDetectAlbums({}, { artistId: id }, ctx()))).toBe('unauthorized');
      expect(await codeOf(M.approveDetectedAlbum({}, { artistId: id, title: 'X' }, ctx()))).toBe('unauthorized');
      expect(await codeOf(M.dismissDetectedAlbum({}, { artistId: id, key: 'x' }, ctx()))).toBe('unauthorized');
    });

    it('plain users and review-only staff are forbidden on all three', async () => {
      const id = String(new mongoose.Types.ObjectId());
      for (const u of [await seedUser(), await seedUser(['catalog.review'])]) {
        expect(await codeOf(Q.catalogDetectAlbums({}, { artistId: id }, ctx(u)))).toBe('forbidden');
        expect(await codeOf(M.approveDetectedAlbum({}, { artistId: id, title: 'X' }, ctx(u)))).toBe('forbidden');
        expect(await codeOf(M.dismissDetectedAlbum({}, { artistId: id, key: 'x' }, ctx(u)))).toBe('forbidden');
      }
    });

    it('manager detects, approves (admin source, once) and dismisses idempotently', async () => {
      const admin = await seedUser(['catalog.manage']);
      const artistId = await seedDetect(admin);
      const found = await Q.catalogDetectAlbums({}, { artistId }, ctx(admin));
      expect(found).toEqual([{ key: expect.any(String), title: 'Homogenic', songCount: 2, year: '1997' }]);

      const album = await M.approveDetectedAlbum({}, { artistId, title: 'Homogenic', year: '1997' }, ctx(admin));
      expect(album).toMatchObject({ title: 'Homogenic', status: 'approved', source: 'admin' });
      expect(await codeOf(M.approveDetectedAlbum({}, { artistId, title: 'Homogenic', year: '1997' }, ctx(admin)))).toBe('catalog_duplicate');
      expect(await CatalogAlbum.countDocuments()).toBe(1);

      expect(await M.dismissDetectedAlbum({}, { artistId, key: 'vespertine' }, ctx(admin))).toBe(true);
      expect(await M.dismissDetectedAlbum({}, { artistId, key: 'vespertine' }, ctx(admin))).toBe(true);
    });
  });
});
