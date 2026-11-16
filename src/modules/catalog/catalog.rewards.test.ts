import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import User from '../users/user.model.js';
import BadgeDefinition from '../badges/badge-definition.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { computeXPFromStats, seedBuiltinBadges, triggerBadgeCheck, recomputeSyncStats, recomputeXP } from '../badges/badge.service.js';
import { awardCatalogCredit, revokeCatalogCredit } from './catalog.rewards.js';
import { reviewCatalogEntry } from './catalog.review.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), BadgeDefinition.init(), CatalogArtist.init(), CatalogAlbum.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), BadgeDefinition.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({})]);
  await seedBuiltinBadges();
});

let seq = 0;
const seedUser = async (extra: Record<string, unknown> = {}): Promise<string> => {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `w${n}`, email: `w${n}@x.test`, passwordHash: 'x', isVerified: true, permissions: [], ...extra,
  });
  return insertedId.toString();
};
type Snap = { stats?: Record<string, number>; progression?: { xp?: number }; badges?: { id: string }[] };
const snap = async (id: string) => (await User.findById(id).lean<Snap>())!;
const badgeIds = async (id: string) => ((await snap(id)).badges ?? []).map((b) => b.id);
// The badge check inside award is fire-and-forget, so poll for its effect instead of sleeping.
const untilBadge = (id: string, badge: string) => vi.waitFor(async () => expect(await badgeIds(id)).toContain(badge));
const untilXp = (id: string, xp: number) => vi.waitFor(async () => expect((await snap(id)).progression?.xp).toBe(xp));

describe('computeXPFromStats', () => {
  it('adds 125 per artist and 250 per album', () => {
    expect(computeXPFromStats(0, { catalogArtistsApproved: 2, catalogAlbumsApproved: 1 })).toBe(500);
  });
});

describe('seeds', () => {
  it('seeds the 7 catalog badges idempotently', async () => {
    expect(await seedBuiltinBadges()).toBe(0);
    const defs = await BadgeDefinition.find({ id: { $in: ['scout', 'archivist', 'curator', 'chronicler', 'historian', 'librarian', 'gatekeeper'] } }).lean();
    expect(defs.map((d) => [d.id, d.conditionType, d.conditionValue, d.xpReward]).sort()).toEqual([
      ['archivist', 'catalog_approved', 10, 100],
      ['chronicler', 'catalog_approved', 100, 400],
      ['curator', 'catalog_approved', 50, 250],
      ['gatekeeper', 'catalog_reviews', 100, 150],
      ['historian', 'catalog_approved', 175, 600],
      ['librarian', 'catalog_approved', 250, 1000],
      ['scout', 'catalog_approved', 1, 50],
    ]);
    expect(defs.every((d) => d.label.es && d.description.es && d.autoGrant && d.isBuiltin)).toBe(true);
  });
});

describe('awardCatalogCredit / revokeCatalogCredit', () => {
  it('increments, recomputes XP and grants scout at 1', async () => {
    const u = await seedUser();
    await awardCatalogCredit(u, 'artist');
    await untilBadge(u, 'scout');
    // 125 for the artist plus 50 from the scout badge; no other badge applies to this user.
    await untilXp(u, 125 + 50);
    expect((await snap(u)).stats?.catalogArtistsApproved).toBe(1);
    await awardCatalogCredit(u, 'album');
    await untilXp(u, 125 + 250 + 50);
    expect((await snap(u)).stats?.catalogAlbumsApproved).toBe(1);
  });

  it('grants archivist at 10 combined approvals and gatekeeper at 100 reviews', async () => {
    const u = await seedUser({ stats: { catalogArtistsApproved: 6, catalogAlbumsApproved: 4 } });
    await triggerBadgeCheck(u, 'catalog_approved');
    expect(await badgeIds(u)).toEqual(expect.arrayContaining(['scout', 'archivist']));
    expect(await badgeIds(u)).not.toContain('curator');
    const r = await seedUser({ stats: { catalogReviews: 100 } });
    await triggerBadgeCheck(r, 'catalog_review');
    expect(await badgeIds(r)).toContain('gatekeeper');
    const r2 = await seedUser({ stats: { catalogReviews: 99 } });
    await triggerBadgeCheck(r2, 'catalog_review');
    expect(await badgeIds(r2)).not.toContain('gatekeeper');
  });

  it('revoke lowers the counter and XP, never goes below 0, and keeps badges', async () => {
    const u = await seedUser();
    await awardCatalogCredit(u, 'album');
    await untilBadge(u, 'scout');
    await untilXp(u, 250 + 50);
    const before = (await snap(u)).progression!.xp!;
    await revokeCatalogCredit(u, 'album');
    const s = await snap(u);
    expect(s.stats?.catalogAlbumsApproved).toBe(0);
    expect(s.progression?.xp).toBe(before - 250);
    expect(await badgeIds(u)).toContain('scout');
    await revokeCatalogCredit(u, 'album');
    await revokeCatalogCredit(u, 'artist');
    const after = await snap(u);
    expect(after.stats?.catalogAlbumsApproved).toBe(0);
    expect(after.stats?.catalogArtistsApproved ?? 0).toBe(0);
    expect(after.progression?.xp).toBe(before - 250);
  });

  it('concurrent revokes cannot push the counter negative', async () => {
    const u = await seedUser({ stats: { catalogArtistsApproved: 1 } });
    await Promise.all([1, 2, 3].map(() => revokeCatalogCredit(u, 'artist')));
    expect((await snap(u)).stats?.catalogArtistsApproved).toBe(0);
  });
});

describe('integration with review', () => {
  it('community approval credits the submitter exactly once; a second review attempt does not', async () => {
    const submitter = await seedUser();
    const reviewer = await seedUser({ permissions: ['catalog.review'] });
    const a = await CatalogArtist.create({
      name: 'Björk', nameKey: 'björk', status: 'pending', source: 'community', submittedBy: new mongoose.Types.ObjectId(submitter),
    });
    const rev = { userId: reviewer, permissions: ['catalog.review'] };
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    await reviewCatalogEntry(rev, 'artist', String(a._id), 'approve');
    await untilBadge(submitter, 'scout');
    expect((await snap(submitter)).stats?.catalogArtistsApproved).toBe(1);
    expect((await snap(reviewer)).stats?.catalogReviews).toBe(1);
    expect((await CatalogArtist.findById(a._id))!.creditAwarded).toBe(true);
  });

  it('admin-sourced approval earns nothing', async () => {
    const submitter = await seedUser();
    const reviewer = await seedUser({ permissions: ['catalog.review'] });
    const a = await CatalogArtist.create({
      name: 'Admin', nameKey: 'admin', status: 'pending', source: 'admin', submittedBy: new mongoose.Types.ObjectId(submitter),
    });
    await reviewCatalogEntry({ userId: reviewer, permissions: ['catalog.review'] }, 'artist', String(a._id), 'approve');
    expect((await snap(submitter)).stats?.catalogArtistsApproved ?? 0).toBe(0);
  });
});

describe('stats recompute job', () => {
  it('leaves catalog counters intact', async () => {
    const u = await seedUser({ stats: { catalogArtistsApproved: 3, catalogAlbumsApproved: 2, catalogReviews: 7, minutesSynced: 99 } });
    await recomputeSyncStats(u);
    const s = await snap(u);
    expect(s.stats).toMatchObject({ catalogArtistsApproved: 3, catalogAlbumsApproved: 2, catalogReviews: 7, minutesSynced: 0 });
    await recomputeXP(u);
    expect((await snap(u)).progression?.xp).toBe(3 * 125 + 2 * 250);
  });
});
