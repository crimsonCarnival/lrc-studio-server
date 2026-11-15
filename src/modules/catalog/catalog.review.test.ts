import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
const { triggerBadgeCheck } = vi.hoisted(() => ({ triggerBadgeCheck: vi.fn(async () => []) }));
vi.mock('../badges/badge.service.js', () => ({ triggerBadgeCheck }));
const { awardCatalogCredit } = vi.hoisted(() => ({ awardCatalogCredit: vi.fn(async () => undefined) }));
vi.mock('./catalog.rewards.js', () => ({ awardCatalogCredit, revokeCatalogCredit: async () => undefined }));

import User from '../users/user.model.js';
import Notification from '../notifications/notification.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { reviewCatalogEntry } from './catalog.review.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), CatalogArtist.init(), CatalogAlbum.init(), Notification.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  triggerBadgeCheck.mockClear();
  awardCatalogCredit.mockClear();
  await Promise.all([User.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}), Notification.deleteMany({})]);
});

let seq = 0;
const seedUser = async (permissions: string[] = []): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `r${n}`, email: `r${n}@x.test`, passwordHash: 'x', isVerified: true, permissions,
  });
  return insertedId.toString();
};
const REVIEW = ['catalog.review'];
const reviewerOf = async () => {
  const userId = await seedUser(REVIEW);
  return { userId, permissions: REVIEW };
};
const seedArtist = async (submittedBy: string, over: Record<string, unknown> = {}) =>
  CatalogArtist.create({
    name: 'Björk', nameKey: 'björk', status: 'pending', source: 'community',
    submittedBy: new mongoose.Types.ObjectId(submittedBy), ...over,
  });
const seedAlbum = async (submittedBy: string, artistId: unknown, over: Record<string, unknown> = {}) =>
  CatalogAlbum.create({
    artistId, title: 'Homogenic', titleKey: 'homogenic', status: 'pending', source: 'community',
    submittedBy: new mongoose.Types.ObjectId(submittedBy), ...over,
  });
const errOf = (r: object) => r as { error: string; status: number; code: string };
const reviews = async (id: string) =>
  (await User.findById(id).lean<{ stats?: { catalogReviews?: number } }>())?.stats?.catalogReviews ?? 0;

describe('reviewCatalogEntry', () => {
  it('refuses a reviewer without catalog.review', async () => {
    const submitter = await seedUser();
    const nobody = await seedUser();
    const a = await seedArtist(submitter);
    const r = errOf(await reviewCatalogEntry({ userId: nobody, permissions: [] }, 'artist', String(a._id), 'approve'));
    expect(r).toMatchObject({ code: 'CATALOG_FORBIDDEN', status: 403 });
  });

  it('re-checks the permission in the DB, not only the passed one', async () => {
    const submitter = await seedUser();
    const stale = await seedUser([]); // permission revoked since the session loaded it
    const a = await seedArtist(submitter);
    const r = errOf(await reviewCatalogEntry({ userId: stale, permissions: REVIEW }, 'artist', String(a._id), 'approve'));
    expect(r.code).toBe('CATALOG_FORBIDDEN');
    expect((await CatalogArtist.findById(a._id))!.status).toBe('pending');
  });

  it('refuses reviewing your own submission', async () => {
    const rev = await reviewerOf();
    const a = await seedArtist(rev.userId);
    const r = errOf(await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve'));
    expect(r).toMatchObject({ code: 'CATALOG_SELF_REVIEW', status: 403 });
    expect((await CatalogArtist.findById(a._id))!.status).toBe('pending');
  });

  it('404s on an unknown or malformed id', async () => {
    const rev = await reviewerOf();
    expect(errOf(await reviewCatalogEntry(rev, 'artist', 'nope', 'approve')).code).toBe('CATALOG_NOT_FOUND');
    expect(errOf(await reviewCatalogEntry(rev, 'artist', String(new mongoose.Types.ObjectId()), 'approve')).code).toBe('CATALOG_NOT_FOUND');
  });

  it('approves: status, reviewer, slug, one notification, reviewer counter', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    const r = await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve', '  <b>nice</b> ');
    if (!('entry' in r)) throw new Error('expected entry');
    const stored = (await CatalogArtist.findById(a._id))!;
    expect(stored.status).toBe('approved');
    expect(String(stored.reviewedBy)).toBe(rev.userId);
    expect(stored.reviewedAt).toBeInstanceOf(Date);
    expect(stored.reviewNote).toBe('nice');
    expect(stored.slug).toBe('bjork');
    expect(r.entry.slug).toBe('bjork');
    const notes = await Notification.find({ userId: submitter }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'catalog_approved', body: 'Björk' });
    expect(await reviews(rev.userId)).toBe(1);
    expect(triggerBadgeCheck).toHaveBeenCalledTimes(1);
    expect(triggerBadgeCheck).toHaveBeenCalledWith(rev.userId, 'catalog_review');
  });

  it('rejects: stores the note, notifies with it, counts the review, assigns no slug', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    const r = await reviewCatalogEntry(rev, 'artist', String(a._id), 'reject', 'Duplicate of another act');
    expect('entry' in r).toBe(true);
    const stored = (await CatalogArtist.findById(a._id))!;
    expect(stored).toMatchObject({ status: 'rejected', reviewNote: 'Duplicate of another act', slug: null });
    const notes = await Notification.find({ userId: submitter }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: 'catalog_rejected', body: 'Björk', meta: { note: 'Duplicate of another act' } });
    expect(await reviews(rev.userId)).toBe(1);
    expect(awardCatalogCredit).not.toHaveBeenCalled();
  });

  it('rejects a note longer than 500 characters', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    const r = errOf(await reviewCatalogEntry(rev, 'artist', String(a._id), 'reject', 'x'.repeat(501)));
    expect(r).toMatchObject({ code: 'CATALOG_INVALID_INPUT', status: 400 });
    expect((await CatalogArtist.findById(a._id))!.status).toBe('pending');
  });

  it('two concurrent reviews: exactly one wins and effects apply once', async () => {
    const submitter = await seedUser();
    const r1 = await reviewerOf();
    const r2 = await reviewerOf();
    const a = await seedArtist(submitter);
    const [x, y] = await Promise.all([
      reviewCatalogEntry(r1, 'artist', String(a._id), 'approve'),
      reviewCatalogEntry(r2, 'artist', String(a._id), 'approve'),
    ]);
    const wins = [x, y].filter((v) => 'entry' in v);
    const losses = [x, y].filter((v) => 'code' in v);
    expect(wins).toHaveLength(1);
    expect(errOf(losses[0]).code).toBe('CATALOG_ALREADY_REVIEWED');
    expect(await Notification.countDocuments({ userId: submitter })).toBe(1);
    expect(awardCatalogCredit).toHaveBeenCalledTimes(1);
    expect((await reviews(r1.userId)) + (await reviews(r2.userId))).toBe(1);
  });

  it('replaying a decision returns ALREADY_REVIEWED with no extra reward', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    const again = errOf(await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve'));
    expect(again).toMatchObject({ code: 'CATALOG_ALREADY_REVIEWED', status: 409 });
    expect(awardCatalogCredit).toHaveBeenCalledTimes(1);
    expect(await reviews(rev.userId)).toBe(1);
  });

  it('refuses an album whose artist is not approved, leaving it pending', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const artist = await seedArtist(submitter);
    const album = await seedAlbum(submitter, artist._id);
    const r = errOf(await reviewCatalogEntry(rev, 'album', String(album._id), 'approve'));
    expect(r).toMatchObject({ code: 'CATALOG_PARENT_NOT_APPROVED', status: 422 });
    expect((await CatalogAlbum.findById(album._id))!.status).toBe('pending');
    expect(await reviews(rev.userId)).toBe(0);
  });

  it('approves an album under an approved artist and slugs it', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const artist = await seedArtist(submitter, { status: 'approved', slug: 'bjork' });
    const album = await seedAlbum(submitter, artist._id);
    const r = await reviewCatalogEntry(rev, 'album', String(album._id), 'approve');
    expect('entry' in r).toBe(true);
    const stored = (await CatalogAlbum.findById(album._id))!;
    expect(stored).toMatchObject({ status: 'approved', slug: 'homogenic' });
    expect(awardCatalogCredit).toHaveBeenCalledWith(submitter, 'album');
  });

  it('rejects an album even when its artist is pending', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const artist = await seedArtist(submitter);
    const album = await seedAlbum(submitter, artist._id);
    const r = await reviewCatalogEntry(rev, 'album', String(album._id), 'reject', 'no');
    expect('entry' in r).toBe(true);
  });

  it('admin-created entries earn nothing', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter, { source: 'admin' });
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    expect(awardCatalogCredit).not.toHaveBeenCalled();
    expect((await CatalogArtist.findById(a._id))!.creditAwarded).toBe(false);
  });

  it('community approval awards credit once and marks creditAwarded', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    expect(awardCatalogCredit).toHaveBeenCalledWith(submitter, 'artist');
    expect((await CatalogArtist.findById(a._id))!.creditAwarded).toBe(true);
  });

  it('keeps the entry approved when the reward hook throws', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    awardCatalogCredit.mockRejectedValueOnce(new Error('boom'));
    const r = await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    expect('entry' in r).toBe(true);
    expect(await CatalogArtist.findById(a._id)).toMatchObject({ status: 'approved', creditAwarded: true });
  });

  it('bait-and-switch: an edit after the reviewer loaded the entry yields CATALOG_CHANGED', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    const loadedAt = (await CatalogArtist.findById(a._id))!.updatedAt!;
    await new Promise((res) => setTimeout(res, 5));
    await CatalogArtist.updateOne({ _id: a._id }, { $set: { name: 'Something else' } });
    const r = errOf(await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve', undefined, { expectedUpdatedAt: loadedAt }));
    expect(r).toMatchObject({ code: 'CATALOG_CHANGED', status: 409 });
    expect((await CatalogArtist.findById(a._id))!.status).toBe('pending');
  });

  it('accepts an unchanged expectedUpdatedAt (ISO string too)', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    const loadedAt = (await CatalogArtist.findById(a._id))!.updatedAt!;
    const r = await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve', undefined, { expectedUpdatedAt: loadedAt.toISOString() });
    expect('entry' in r).toBe(true);
  });

  it('expectedUpdatedAt on an already-reviewed entry reports ALREADY_REVIEWED', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter);
    const loadedAt = (await CatalogArtist.findById(a._id))!.updatedAt!;
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'reject');
    const r = errOf(await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve', undefined, { expectedUpdatedAt: loadedAt }));
    expect(r.code).toBe('CATALOG_ALREADY_REVIEWED');
  });

  it('awards at most once even when the flag is already set (retry or backfill)', async () => {
    const submitter = await seedUser();
    const rev = await reviewerOf();
    const a = await seedArtist(submitter, { creditAwarded: true });
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    expect(awardCatalogCredit).not.toHaveBeenCalled();
  });

  it('refuses a reviewer who is deleted or banned in the DB', async () => {
    const submitter = await seedUser();
    const a = await seedArtist(submitter);
    for (const extra of [{ isDeleted: true }, { ban: { active: true } }]) {
      const { insertedId } = await User.collection.insertOne({
        accountName: `x${++seq}`, email: `x${seq}@x.test`, passwordHash: 'x', isVerified: true, permissions: REVIEW, ...extra,
      });
      const r = errOf(await reviewCatalogEntry({ userId: insertedId.toString(), permissions: REVIEW }, 'artist', String(a._id), 'approve'));
      expect(r.code).toBe('CATALOG_FORBIDDEN');
    }
    expect((await CatalogArtist.findById(a._id))!.status).toBe('pending');
  });

  // Counter/XP effects of approve and revoke are covered end to end in catalog.rewards.test.ts.
});
