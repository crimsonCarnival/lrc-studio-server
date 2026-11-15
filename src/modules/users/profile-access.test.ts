import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import User from './user.model.js';
import Block from '../blocks/block.model.js';
import { resolveProfileAccess } from './profile-access.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), Block.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Block.deleteMany({})]);
});

let seq = 0;
async function makeUser(extra: Record<string, unknown> = {}) {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `user${n}`,
    email: `user${n}@x.test`,
    passwordHash: 'x',
    ...extra,
  });
  return { _id: insertedId, accountName: `user${n}`, id: insertedId.toString() };
}

describe('resolveProfileAccess', () => {
  it('returns missing for a banned user', async () => {
    const banned = await makeUser({ ban: { active: true } });
    expect(await resolveProfileAccess(banned.accountName, false, null)).toEqual({ kind: 'missing' });
  });

  it('returns hidden when the owner blocked the viewer', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    await Block.create({ blockerId: owner._id, blockedId: viewer._id });
    expect(await resolveProfileAccess(owner.accountName, false, viewer.id)).toEqual({ kind: 'hidden' });
  });

  it('returns stub when the viewer blocked the owner', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    await Block.create({ blockerId: viewer._id, blockedId: owner._id });
    const a = await resolveProfileAccess(owner.accountName, false, viewer.id);
    expect(a.kind).toBe('stub');
  });

  it('owner gets an unfiltered projectFilter', async () => {
    const owner = await makeUser();
    const a = await resolveProfileAccess(owner.accountName, false, owner.id);
    if (a.kind !== 'ok') throw new Error('expected ok');
    expect(a.isOwner).toBe(true);
    expect(a.projectFilter).toEqual({ userId: owner._id });
    expect(a.playlistFilter).toEqual({ userId: owner._id });
  });

  it('asVisitor on own profile gets the visitor filter', async () => {
    const owner = await makeUser();
    const a = await resolveProfileAccess(owner.accountName, true, owner.id);
    if (a.kind !== 'ok') throw new Error('expected ok');
    expect(a.isOwner).toBe(false);
    expect(a.viewerId).toBeNull();
    expect(a.projectFilter).toEqual({ userId: owner._id, public: true, listed: { $ne: false } });
    expect(a.playlistFilter).toEqual({ userId: owner._id, isPublic: true, listed: { $ne: false } });
  });
});
