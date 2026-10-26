import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Notification from './notification.model.js';
import Follow from '../users/follow.model.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { invalidatePreferences } from '../user-preferences/user-preferences.service.js';
import {
  notifyFollowedProject,
  notifyLevelUp,
  notifyPlaylistSaved,
  notifyStarMilestone,
  notifyWallComment,
} from './notifications.events.js';

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
  await Promise.all([Notification.deleteMany({}), Follow.deleteMany({}), UserPreferences.deleteMany({})]);
});

const id = () => new mongoose.Types.ObjectId();
const actor = (userId: mongoose.Types.ObjectId, accountName = 'ann') => ({ userId: userId.toString(), accountName, avatarUrl: null });

describe('followed user projects', () => {
  it('tells "uploads" followers about a new project and leaves "off" followers alone', async () => {
    const author = id(), uploads = id(), all = id(), off = id();
    await Follow.create([
      { followerId: uploads, followingId: author, notify: 'uploads' },
      { followerId: all, followingId: author, notify: 'all' },
      { followerId: off, followingId: author, notify: 'off' },
    ]);
    await notifyFollowedProject({ author: actor(author), publicId: 'p1', projectTitle: 'Song', kind: 'published' });
    const told = (await Notification.find({ type: 'followed_project' }).lean()).map((n) => n.userId.toString()).sort();
    expect(told).toEqual([uploads.toString(), all.toString()].sort());
  });

  it('tells only "all" followers about an edit, and only once per window', async () => {
    const author = id(), uploads = id(), all = id();
    await Follow.create([
      { followerId: uploads, followingId: author, notify: 'uploads' },
      { followerId: all, followingId: author, notify: 'all' },
    ]);
    await notifyFollowedProject({ author: actor(author), publicId: 'edit-once', projectTitle: 'Song', kind: 'updated' });
    await notifyFollowedProject({ author: actor(author), publicId: 'edit-once', projectTitle: 'Song', kind: 'updated' });
    const told = await Notification.find({ type: 'followed_project' }).lean();
    expect(told).toHaveLength(1);
    expect(told[0].userId.toString()).toBe(all.toString());
    expect(told[0].meta).toMatchObject({ kind: 'updated' });
  });

  it('respects a follower who turned the notification type off', async () => {
    const author = id(), follower = id();
    await Follow.create({ followerId: follower, followingId: author, notify: 'all' });
    await UserPreferences.create({ userId: follower, notifications: { followed_project: false } });
    invalidatePreferences(follower.toString());
    await notifyFollowedProject({ author: actor(author), publicId: 'p2', projectTitle: 'Song', kind: 'published' });
    expect(await Notification.countDocuments({ type: 'followed_project' })).toBe(0);
  });
});

describe('aggregated and one-off notifications', () => {
  it('folds unread wall comments from several people into one notification', async () => {
    const owner = id(), a = id(), b = id();
    await notifyWallComment({ recipientId: owner.toString(), actor: actor(a, 'ann'), wallOwnerAccountName: 'sam', reply: false });
    await notifyWallComment({ recipientId: owner.toString(), actor: actor(b, 'bob'), wallOwnerAccountName: 'sam', reply: false });
    const docs = await Notification.find({ type: 'wall_comment' }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].actorCount).toBe(2);
    expect(docs[0].meta).toMatchObject({ wall: 'sam', reply: false });
  });

  it('does not notify someone about their own comment', async () => {
    const owner = id();
    await notifyWallComment({ recipientId: owner.toString(), actor: actor(owner), wallOwnerAccountName: 'sam', reply: false });
    expect(await Notification.countDocuments({ type: 'wall_comment' })).toBe(0);
  });

  it('notifies a star milestone once, and only at a milestone', async () => {
    const owner = id();
    await notifyStarMilestone({ ownerId: owner.toString(), publicId: 'p3', projectTitle: 'Song', count: 7 });
    await notifyStarMilestone({ ownerId: owner.toString(), publicId: 'p3', projectTitle: 'Song', count: 10 });
    await notifyStarMilestone({ ownerId: owner.toString(), publicId: 'p3', projectTitle: 'Song', count: 10 });
    expect(await Notification.countDocuments({ type: 'star_milestone' })).toBe(1);
  });

  it('counts people who saved a playlist, and skips the owner saving their own', async () => {
    const owner = id(), a = id(), b = id();
    const base = { ownerId: owner.toString(), playlistId: 'pl1', name: 'Mix' };
    await notifyPlaylistSaved({ ...base, actor: actor(a, 'ann') });
    await notifyPlaylistSaved({ ...base, actor: actor(b, 'bob') });
    await notifyPlaylistSaved({ ...base, actor: actor(owner, 'sam') });
    const docs = await Notification.find({ type: 'playlist_saved' }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].actorCount).toBe(2);
  });

  it('records a level-up with its level', async () => {
    const user = id();
    await notifyLevelUp(user.toString(), 5);
    const doc = await Notification.findOne({ type: 'level_up' }).lean();
    expect(doc?.meta).toMatchObject({ level: 5 });
  });
});
