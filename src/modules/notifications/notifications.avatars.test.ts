/**
 * Avatars are deleted from storage when replaced, so anything that shows one
 * must read the current URL, not the copy taken when the row was written.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Notification from './notification.model.js';
import User from '../users/user.model.js';
import { clearHeap } from '../../lib/notification-heap.js';
import { listNotifications } from './notifications.service.js';
import { activityResolvers } from '../../graphql/resolvers/activity.resolvers.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([Notification.deleteMany({}), User.collection.deleteMany({})]);
});

let n = 0;
async function mkUser(avatarUrl: string | null) {
  n++;
  const res = await User.collection.insertOne({
    accountName: `user${n}`, email: `u${n}@x.test`, passwordHash: 'x',
    role: 'user', permissions: [], ban: { active: false }, avatarUrl,
  });
  return { id: res.insertedId, accountName: `user${n}` };
}

describe('listNotifications', () => {
  it("shows each actor's current avatar, not the one stored at notify time", async () => {
    const owner = await mkUser(null);
    const actor = await mkUser('https://cdn/new.webp');
    const gone = new mongoose.Types.ObjectId();
    await Notification.create({
      userId: owner.id, type: 'star', publicId: 'p1', actorCount: 2,
      actors: [
        { userId: actor.id, accountName: actor.accountName, avatarUrl: 'https://cdn/old.webp' },
        { userId: gone, accountName: 'deleted', avatarUrl: 'https://cdn/kept.webp' },
      ],
    });
    clearHeap(owner.id.toString());

    const { notifications } = await listNotifications(owner.id.toString());
    expect(notifications[0].actors.map((a) => a.avatarUrl)).toEqual(['https://cdn/new.webp', 'https://cdn/kept.webp']);
  });
});

describe('Activity.coverImage', () => {
  const coverImage = activityResolvers.Activity.coverImage;

  it("resolves a follow's cover to the followed user's current avatar", async () => {
    const target = await mkUser('https://cdn/new.webp');
    await expect(coverImage({ type: 'user_followed', targetPath: `/${target.accountName}`, coverImage: 'https://cdn/old.webp' }))
      .resolves.toBe('https://cdn/new.webp');
  });

  it('falls back to the stored copy when the account name no longer resolves', async () => {
    await expect(coverImage({ type: 'user_followed', targetPath: '/renamed', coverImage: 'https://cdn/old.webp' }))
      .resolves.toBe('https://cdn/old.webp');
  });

  it('leaves project covers alone', async () => {
    await expect(coverImage({ type: 'project_published', targetPath: '/user1', coverImage: 'https://cdn/cover.webp' }))
      .resolves.toBe('https://cdn/cover.webp');
  });
});
