import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

import Follow from './follow.model.js';
import User from './user.model.js';

const ID_A = new mongoose.Types.ObjectId();
const ID_B = new mongoose.Types.ObjectId();

describe('Follow model', () => {
  it('creates a follow document', async () => {
    const doc = await Follow.create({ followerId: ID_A, followingId: ID_B });
    expect(doc.followerId.toString()).toBe(ID_A.toString());
    expect(doc.followingId.toString()).toBe(ID_B.toString());
    expect(doc.createdAt).toBeDefined();
  });

  it('rejects duplicate follows', async () => {
    await Follow.create({ followerId: ID_A, followingId: ID_B });
    await expect(Follow.create({ followerId: ID_A, followingId: ID_B })).rejects.toThrow();
  });

  it('allows same follower to follow different users', async () => {
    const ID_C = new mongoose.Types.ObjectId();
    await Follow.create({ followerId: ID_A, followingId: ID_B });
    const doc = await Follow.create({ followerId: ID_A, followingId: ID_C });
    expect(doc).toBeDefined();
  });
});

describe('User social field', () => {
  it('defaults social counts to 0 and showFollowers to true', async () => {
    const user = await User.create({
      accountName: 'testuser_social',
      passwordHash: 'OAUTH_NO_PASSWORD',
    });
    expect((user as any).social.followerCount).toBe(0);
    expect((user as any).social.followingCount).toBe(0);
    expect((user as any).social.showFollowers).toBe(true);
  });
});
