import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';

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
