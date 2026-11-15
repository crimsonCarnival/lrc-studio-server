import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import BadgeDefinition from './badge-definition.model.js';
import { setNameTag, revokeBadge, deleteBadgeDef } from './badge.service.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.init();
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
  await BadgeDefinition.deleteMany({});
});

let seq = 0;
async function mkUser(extra: Record<string, unknown> = {}): Promise<string> {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({ accountName: `tag${n}`, email: `tag${n}@x.test`, passwordHash: 'x', createdAt: new Date(), ...extra });
  return insertedId.toString();
}

describe('User.nameTagBadgeId', () => {
  it('defaults nameTagBadgeId to null', async () => {
    const id = await mkUser();
    const user = await User.findById(id);
    expect(user?.nameTagBadgeId).toBeNull();
    expect(user?.toPublic().nameTagBadgeId).toBeNull();
  });
});

const held = (id: string) => ({ id, grantedAt: new Date(), grantedBy: 'system' });

describe('setNameTag', () => {
  it('equips a held badge', async () => {
    const uid = await mkUser({ badges: [held('b1')] });
    expect(await setNameTag(uid, 'b1')).toEqual({ ok: true });
    expect((await User.findById(uid))?.nameTagBadgeId).toBe('b1');
  });
  it('refuses a badge the user does not hold', async () => {
    const uid = await mkUser({ badges: [held('b1')] });
    expect(await setNameTag(uid, 'b2')).toEqual({ ok: false, code: 'not_owned' });
    expect((await User.findById(uid))?.nameTagBadgeId).toBeNull();
  });
  it('refuses an unknown id', async () => {
    const uid = await mkUser();
    expect(await setNameTag(uid, 'nope')).toEqual({ ok: false, code: 'not_owned' });
  });
  it('null clears the tag', async () => {
    const uid = await mkUser({ badges: [held('b1')], nameTagBadgeId: 'b1' });
    expect(await setNameTag(uid, null)).toEqual({ ok: true });
    expect((await User.findById(uid))?.nameTagBadgeId).toBeNull();
  });
  it('revokeBadge clears the equipped tag', async () => {
    const uid = await mkUser({ badges: [held('b1'), held('b2')], nameTagBadgeId: 'b1' });
    await revokeBadge(uid, 'b2');
    expect((await User.findById(uid))?.nameTagBadgeId).toBe('b1');
    await revokeBadge(uid, 'b1');
    expect((await User.findById(uid))?.nameTagBadgeId).toBeNull();
  });
  it('deleting a badge definition clears the tag for every holder', async () => {
    await BadgeDefinition.collection.insertOne({ id: 'b1', label: { en: 'B' }, description: { en: 'D' }, icon: 'x', color: '#fff', rarity: 'common', isBuiltin: false });
    const a = await mkUser({ badges: [held('b1')], nameTagBadgeId: 'b1' });
    const b = await mkUser({ badges: [held('b1'), held('b2')], nameTagBadgeId: 'b1' });
    const c = await mkUser({ badges: [held('b2')], nameTagBadgeId: 'b2' });
    await deleteBadgeDef('b1');
    expect((await User.findById(a))?.nameTagBadgeId).toBeNull();
    expect((await User.findById(b))?.nameTagBadgeId).toBeNull();
    expect((await User.findById(c))?.nameTagBadgeId).toBe('b2');
  });
});
