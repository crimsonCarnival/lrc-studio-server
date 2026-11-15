import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import ProfileShare from '../modules/projects/profile-share.model.js';
import Follow from '../modules/users/follow.model.js';
import User from '../modules/users/user.model.js';
import BadgeDefinition from '../modules/badges/badge-definition.model.js';
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
  await Promise.all([ProfileShare.init(), Follow.init()]);
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([ProfileShare.deleteMany({}), Follow.deleteMany({}), User.deleteMany({})]);
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

describe('nameTag', () => {
  const def = { id: 'b1', label: { en: 'Open Mic', es: 'Micro abierto' }, description: { en: 'd', es: 'd' }, icon: '🎤', color: 'amber' };
  const tag = { ...def };
  const makeUser = async (extra: Record<string, unknown> = {}) => {
    const id = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: id, accountName: `u${id.toString()}`, ...extra });
    return id.toString();
  };

  beforeEach(async () => {
    await BadgeDefinition.deleteMany({});
    await BadgeDefinition.create({ ...def, conditionType: 'manual', conditionValue: null, autoGrant: false, createdBy: null });
  });

  it('returns the equipped badge', async () => {
    const id = await makeUser({ nameTagBadgeId: 'b1' });
    expect(await run('PublicUser', 'nameTag', [{ id }])).toEqual([tag]);
  });

  it('null when nothing is equipped and the user is not staff', async () => {
    const id = await makeUser({ nameTagBadgeId: null, permissions: [] });
    expect(await run('PublicUser', 'nameTag', [{ id }])).toEqual([null]);
  });

  it('staff with nothing equipped get builtin:staff', async () => {
    const id = await makeUser({ permissions: ['users.view'] });
    const [result] = (await run('PublicUser', 'nameTag', [{ id }])) as Array<{ id: string; color: string }>;
    expect(result.id).toBe('builtin:staff');
    expect(result.color).toBe('primary');
  });

  it('staff who equipped a tag keep it', async () => {
    const id = await makeUser({ permissions: ['users.view'], nameTagBadgeId: 'b1' });
    expect(await run('FollowUser', 'nameTag', [{ id }])).toEqual([tag]);
  });

  it('equipped id whose definition no longer exists → null (or builtin:staff for staff)', async () => {
    const plain = await makeUser({ nameTagBadgeId: 'gone' });
    const staff = await makeUser({ nameTagBadgeId: 'gone', permissions: ['users.view'] });
    const [a, b] = (await run('LeaderboardUser', 'nameTag', [{ id: plain }, { id: staff }])) as Array<{ id: string } | null>;
    expect(a).toBeNull();
    expect(b?.id).toBe('builtin:staff');
  });

  it('unknown, malformed or missing ids → null without throwing', async () => {
    expect(await run('WallAuthor', 'nameTag', [{ id: oid() }, { id: 'not-an-id' }, {}])).toEqual([null, null, null]);
  });

  it('one user query and one definition query for a batch', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5].map((i) => makeUser(i % 2 ? { nameTagBadgeId: 'b1' } : { permissions: ['users.view'] })));
    const userFind = vi.spyOn(User, 'find');
    const defFind = vi.spyOn(BadgeDefinition, 'find');
    try {
      const result = await run('User', 'nameTag', ids.map((id) => ({ id })));
      expect(result).toHaveLength(5);
      expect(userFind).toHaveBeenCalledTimes(1);
      expect(defFind).toHaveBeenCalledTimes(1);
    } finally {
      userFind.mockRestore();
      defFind.mockRestore();
    }
  });

  it('uses fields already on the parent', async () => {
    const userFind = vi.spyOn(User, 'find');
    try {
      const result = await run('User', 'nameTag', [
        { id: oid(), nameTagBadgeId: 'b1', permissions: [] },
        { id: oid(), nameTagBadgeId: null, permissions: ['users.view'] },
      ]);
      expect(result).toEqual([tag, expect.objectContaining({ id: 'builtin:staff' })]);
      expect(userFind).not.toHaveBeenCalled();
    } finally {
      userFind.mockRestore();
    }
  });
});

describe('Project.user', () => {
  it('fetches the owner for a raw ObjectId userId, as a lean find returns it', async () => {
    const id = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: id, accountName: 'owner', displayName: 'Owner' });

    const [user] = await run('Project', 'user', [{ userId: id }]) as Array<{ accountName?: string } | null>;

    expect(user?.accountName).toBe('owner');
  });

  it('uses a populated owner doc as-is', async () => {
    const populated = { _id: new mongoose.Types.ObjectId(), accountName: 'populated' };
    expect(await run('Project', 'user', [{ userId: populated }])).toEqual([populated]);
  });
});

describe('Project.myProfileShare', () => {
  it('returns the viewer\'s own note only', async () => {
    const viewer = oid();
    await ProfileShare.create([
      { userId: viewer, publicId: 'a', description: 'mine', tags: ['x'] },
      { userId: oid(), publicId: 'b', description: 'theirs' },
    ]);

    expect(await run('Project', 'myProfileShare', [{ publicId: 'a' }, { publicId: 'b' }], viewer))
      .toEqual([{ description: 'mine', tags: ['x'] }, null]);
    expect(await run('Project', 'myProfileShare', [{ publicId: 'a' }])).toEqual([null]);
  });
});

describe('Project profile-share fields', () => {
  it('counts shares per project and returns 0 for a project with none', async () => {
    await ProfileShare.create([
      { userId: oid(), publicId: 'a' },
      { userId: oid(), publicId: 'a' },
      { userId: oid(), publicId: 'b' },
    ]);

    expect(await run('Project', 'profileShareCount', [{ publicId: 'a' }, { publicId: 'b' }, { publicId: 'c' }])).toEqual([2, 1, 0]);
  });

  it('reports only the viewer\'s own shares', async () => {
    const viewer = oid();
    await ProfileShare.create([
      { userId: viewer, publicId: 'a' },
      { userId: oid(), publicId: 'b' },
    ]);

    expect(await run('Project', 'isSharedToProfileByMe', [{ publicId: 'a' }, { publicId: 'b' }], viewer)).toEqual([true, false]);
    expect(await run('Project', 'isSharedToProfileByMe', [{ publicId: 'a' }])).toEqual([false]);
  });
});
