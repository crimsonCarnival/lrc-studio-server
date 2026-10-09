/**
 * User-to-user blocking.
 *
 * Distinct from the admin ban surface: this is one user hiding another, and it
 * is enforced read-side by filtering discovery queries against getBlockedSet(),
 * which is LRU-cached — so cache invalidation is part of the contract, not an
 * implementation detail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Block from '../../db/block.model.js';
import Follow from '../../db/follow.model.js';
import User from '../../db/user.model.js';
import {
  blockUser,
  unblockUser,
  listBlocked,
  getBlockedSet,
  hasBlocked,
  isBlockedEitherWay,
} from './block.service.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Block.init(), Follow.init()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([Block.deleteMany({}), Follow.deleteMany({}), User.deleteMany({})]);
});

let n = 0;
async function mkUser(): Promise<string> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `blk${n}`,
    email: `blk${n}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    role: 'user',
    permissions: [],
    ban: { active: false },
    social: { followerCount: 0, followingCount: 0, totalStarsReceived: 0, totalForksReceived: 0 },
  });
  return res.insertedId.toString();
}

async function follow(followerId: string, followingId: string): Promise<void> {
  await Follow.create({
    followerId: new mongoose.Types.ObjectId(followerId),
    followingId: new mongoose.Types.ObjectId(followingId),
  });
  await Promise.all([
    User.updateOne({ _id: followingId }, { $inc: { 'social.followerCount': 1 } }),
    User.updateOne({ _id: followerId }, { $inc: { 'social.followingCount': 1 } }),
  ]);
}

const counts = (id: string) =>
  User.findById(id).lean<{ social?: { followerCount?: number; followingCount?: number } }>();

describe('blockUser', () => {
  it('records the block', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    expect(await hasBlocked(a, b)).toBe(true);
  });

  it('is directional — blocking is not mutual', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    expect(await hasBlocked(b, a)).toBe(false);
  });

  it('is idempotent — a repeat block creates no second row', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    await blockUser(a, b);
    expect(await Block.countDocuments({})).toBe(1);
  });

  it('refuses a self-block', async () => {
    const a = await mkUser();
    await expect(blockUser(a, a)).rejects.toThrow(/yourself/i);
  });

  it('severs the follow edge in both directions', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await follow(a, b);
    await follow(b, a);

    await blockUser(a, b);
    expect(await Follow.countDocuments({})).toBe(0);
  });

  it('decrements the cached follow counters it severed', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await follow(a, b);
    await follow(b, a);

    await blockUser(a, b);
    expect((await counts(a))?.social).toMatchObject({ followerCount: 0, followingCount: 0 });
    expect((await counts(b))?.social).toMatchObject({ followerCount: 0, followingCount: 0 });
  });

  it('leaves unrelated follow edges intact', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const c = await mkUser();
    await follow(a, b);
    await follow(a, c);

    await blockUser(a, b);
    expect(await Follow.countDocuments({})).toBe(1);
    expect((await counts(c))?.social?.followerCount).toBe(1);
  });

  it('does not drive a counter negative when no edge existed', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    expect((await counts(a))?.social?.followingCount).toBe(0);
    expect((await counts(b))?.social?.followerCount).toBe(0);
  });
});

describe('isBlockedEitherWay', () => {
  it('is true regardless of who blocked whom', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    expect(await isBlockedEitherWay(a, b)).toBe(true);
    expect(await isBlockedEitherWay(b, a)).toBe(true);
  });

  it('is false for unrelated users', async () => {
    const a = await mkUser();
    const b = await mkUser();
    expect(await isBlockedEitherWay(a, b)).toBe(false);
  });
});

describe('getBlockedSet', () => {
  it('includes both directions so discovery filters symmetrically', async () => {
    const viewer = await mkUser();
    const theyBlocked = await mkUser();
    const blockedThem = await mkUser();
    await blockUser(viewer, theyBlocked);
    await blockUser(blockedThem, viewer);

    const set = await getBlockedSet(viewer);
    expect(set.has(theyBlocked)).toBe(true);
    expect(set.has(blockedThem)).toBe(true);
  });

  it('never contains the viewer themselves', async () => {
    const viewer = await mkUser();
    const other = await mkUser();
    await blockUser(viewer, other);
    expect((await getBlockedSet(viewer)).has(viewer)).toBe(false);
  });

  it('returns an empty set for an anonymous viewer', async () => {
    expect((await getBlockedSet(null)).size).toBe(0);
    expect((await getBlockedSet(undefined)).size).toBe(0);
  });

  it('reflects a new block immediately — the LRU cache is invalidated on write', async () => {
    const viewer = await mkUser();
    const other = await mkUser();

    // Warm the cache with the pre-block state first; a stale entry here would
    // silently keep the blocked user visible until eviction.
    expect((await getBlockedSet(viewer)).size).toBe(0);

    await blockUser(viewer, other);
    expect((await getBlockedSet(viewer)).has(other)).toBe(true);
  });

  it('invalidates the blocked side of the pair too, not just the blocker', async () => {
    const blocker = await mkUser();
    const blocked = await mkUser();
    expect((await getBlockedSet(blocked)).size).toBe(0);

    await blockUser(blocker, blocked);
    expect((await getBlockedSet(blocked)).has(blocker)).toBe(true);
  });

  it('reflects an unblock immediately on both sides', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    expect((await getBlockedSet(a)).has(b)).toBe(true);
    expect((await getBlockedSet(b)).has(a)).toBe(true);

    await unblockUser(a, b);
    expect((await getBlockedSet(a)).size).toBe(0);
    expect((await getBlockedSet(b)).size).toBe(0);
  });
});

describe('unblockUser', () => {
  it('removes only the one direction it was asked to remove', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await blockUser(a, b);
    await blockUser(b, a);

    await unblockUser(a, b);
    expect(await hasBlocked(a, b)).toBe(false);
    expect(await hasBlocked(b, a)).toBe(true);
  });

  it('does not restore the follow edges the block severed', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await follow(a, b);
    await blockUser(a, b);
    await unblockUser(a, b);
    expect(await Follow.countDocuments({})).toBe(0);
  });

  it('is a no-op when no block exists', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await expect(unblockUser(a, b)).resolves.toBeUndefined();
  });
});

describe('listBlocked', () => {
  it('lists the viewer\'s blocks newest first', async () => {
    const viewer = await mkUser();
    const first = await mkUser();
    const second = await mkUser();
    await blockUser(viewer, first);
    await new Promise((r) => setTimeout(r, 10));
    await blockUser(viewer, second);

    const list = await listBlocked(viewer);
    expect(list.map((b) => b.id)).toEqual([second, first]);
  });

  it('omits users who blocked the viewer — this list is the viewer\'s own actions', async () => {
    const viewer = await mkUser();
    const other = await mkUser();
    await blockUser(other, viewer);
    expect(await listBlocked(viewer)).toEqual([]);
  });

  it('skips rows whose user record has gone away', async () => {
    const viewer = await mkUser();
    const gone = await mkUser();
    await blockUser(viewer, gone);
    await User.deleteOne({ _id: gone });
    expect(await listBlocked(viewer)).toEqual([]);
  });
});
