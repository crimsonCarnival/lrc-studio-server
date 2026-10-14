import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Boost from '../db/boost.model.js';
import Follow from '../db/follow.model.js';
import User from '../db/user.model.js';
import { hasTimedWord, loaders } from './loaders.js';

type Obj = Record<string, unknown>;
type Loader = (queries: Array<{ obj: Obj }>, context: { userId?: string | null }) => Promise<unknown[]>;

/** Runs one batched field loader the way Mercurius would, for a list of parent objects. */
function run(type: string, field: string, objs: Obj[], userId: string | null = null): Promise<unknown[]> {
  const entry = (loaders as unknown as Record<string, Record<string, { loader: Loader }>>)[type][field];
  return entry.loader(objs.map((obj) => ({ obj })), { userId });
}

const oid = () => new mongoose.Types.ObjectId().toString();

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Boost.init(), Follow.init()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([Boost.deleteMany({}), Follow.deleteMany({}), User.deleteMany({})]);
});

describe('hasTimedWord', () => {
  const word = (time: number | null) => ({ word: 'la', time });

  it('is true when any word in the nested format has a time', () => {
    const doc = { publicId: 'p', sections: [{ lines: [{ words: [word(null)] }, { words: [word(1.5)] }] }] };
    expect(hasTimedWord(doc as never)).toBe(true);
  });

  it('counts a time of 0 as timed', () => {
    const doc = { publicId: 'p', sections: [{ lines: [{ words: [word(0)] }] }] };
    expect(hasTimedWord(doc as never)).toBe(true);
  });

  it('is false when words exist but none is timed, or there are no words', () => {
    expect(hasTimedWord({ publicId: 'p', sections: [{ lines: [{ words: [word(null)] }, {}] }] } as never)).toBe(false);
    expect(hasTimedWord({ publicId: 'p', sections: [] } as never)).toBe(false);
    expect(hasTimedWord(undefined)).toBe(false);
  });

  it('reads the legacy flat format', () => {
    expect(hasTimedWord({ publicId: 'p', lines: [{ words: [word(2)] }] } as never)).toBe(true);
  });
});

describe('FollowUser.isFollowedByMe', () => {
  it('resolves a missing flag from the follow graph instead of returning null', async () => {
    const viewer = oid();
    const followed = oid();
    const stranger = oid();
    await Follow.create({ followerId: viewer, followingId: followed });

    const result = await run('FollowUser', 'isFollowedByMe', [{ id: followed }, { id: stranger }], viewer);

    expect(result).toEqual([true, false]);
  });

  it('is false for a signed-out viewer', async () => {
    const followed = oid();
    await Follow.create({ followerId: oid(), followingId: followed });

    expect(await run('FollowUser', 'isFollowedByMe', [{ id: followed }])).toEqual([false]);
  });

  it('keeps a value the parent resolver already set', async () => {
    const viewer = oid();
    const user = oid();
    await Follow.create({ followerId: viewer, followingId: user });

    // The parent says false; it is trusted rather than recomputed.
    expect(await run('FollowUser', 'isFollowedByMe', [{ id: user, isFollowedByMe: false }], viewer)).toEqual([false]);
  });

  it('does not throw on a parent with no usable id', async () => {
    expect(await run('FollowUser', 'isFollowedByMe', [{ id: '' }, { id: 'deleted' }, {}], oid())).toEqual([false, false, false]);
  });
});

describe('staffRole', () => {
  const makeUser = async (role: string) => {
    const id = new mongoose.Types.ObjectId();
    // Straight into the collection: this test is about the role lookup, not user validation.
    await User.collection.insertOne({ _id: id, accountName: `u${id.toString()}`, role });
    return id.toString();
  };

  it('names staff and hides every other role', async () => {
    const [mod, admin, dev, plain] = await Promise.all(['mod', 'admin', 'superadmin', 'user'].map(makeUser));
    const result = await run('FollowUser', 'staffRole', [{ id: mod }, { id: admin }, { id: dev }, { id: plain }]);
    expect(result).toEqual(['mod', 'admin', 'superadmin', null]);
  });

  it('answers from a role the parent already carries, without a lookup', async () => {
    expect(await run('User', 'staffRole', [{ id: oid(), role: 'admin' }, { id: oid(), role: 'user' }])).toEqual(['admin', null]);
  });

  it('is null for an unknown or unusable id', async () => {
    expect(await run('PublicUser', 'staffRole', [{ id: oid() }, { id: 'not-an-id' }, {}])).toEqual([null, null, null]);
  });
});

describe('Project boost fields', () => {
  it('counts boosts per project and returns 0 for a project with none', async () => {
    await Boost.create([
      { userId: oid(), publicId: 'a' },
      { userId: oid(), publicId: 'a' },
      { userId: oid(), publicId: 'b' },
    ]);

    expect(await run('Project', 'boostCount', [{ publicId: 'a' }, { publicId: 'b' }, { publicId: 'c' }])).toEqual([2, 1, 0]);
  });

  it('reports only the viewer\'s own boosts', async () => {
    const viewer = oid();
    await Boost.create([
      { userId: viewer, publicId: 'a' },
      { userId: oid(), publicId: 'b' },
    ]);

    expect(await run('Project', 'isBoostedByMe', [{ publicId: 'a' }, { publicId: 'b' }], viewer)).toEqual([true, false]);
    expect(await run('Project', 'isBoostedByMe', [{ publicId: 'a' }])).toEqual([false]);
  });
});
