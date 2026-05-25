import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import Notification from './notification.model.js';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: vi.fn(() => ({ to: vi.fn().mockReturnThis(), emit: vi.fn() })),
}));

import * as service from './notifications.service.js';

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

const OWNER = new mongoose.Types.ObjectId().toString();
const ACTOR = new mongoose.Types.ObjectId().toString();
const ACTOR2 = new mongoose.Types.ObjectId().toString();
const PROJECT_ID = 'proj_abc';

describe('upsertSocial', () => {
  it('creates a notification on first star', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'My Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    const doc = await Notification.findOne({ type: 'star', projectId: PROJECT_ID });
    expect(doc).not.toBeNull();
    expect(doc!.actorCount).toBe(1);
    expect(doc!.actors).toHaveLength(1);
    expect(doc!.read).toBe(false);
  });

  it('increments actorCount when a second actor stars', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'My Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'My Song', actorId: ACTOR2, actorAccountName: 'bob', actorAvatarUrl: null });
    const doc = await Notification.findOne({ type: 'star', projectId: PROJECT_ID });
    expect(doc!.actorCount).toBe(2);
    expect(doc!.actors).toHaveLength(2);
  });

  it('does not notify when actor === owner (self-star)', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'My Song', actorId: OWNER, actorAccountName: 'self', actorAvatarUrl: null });
    const count = await Notification.countDocuments({});
    expect(count).toBe(0);
  });
});

describe('createOnce', () => {
  it('creates a sticky notification', async () => {
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    const doc = await Notification.findOne({ type: 'verify_email' });
    expect(doc).not.toBeNull();
    expect(doc!.sticky).toBe(true);
  });

  it('is a no-op when called a second time for same type', async () => {
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    const count = await Notification.countDocuments({ type: 'verify_email' });
    expect(count).toBe(1);
  });
});

describe('resolveSticky', () => {
  it('deletes the sticky notification', async () => {
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    await service.resolveSticky(OWNER, 'verify_email');
    const count = await Notification.countDocuments({ type: 'verify_email' });
    expect(count).toBe(0);
  });
});

describe('dismiss', () => {
  it('deletes a non-sticky notification', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    const doc = await Notification.findOne({ type: 'star' });
    await service.dismiss(OWNER, doc!._id.toString());
    const count = await Notification.countDocuments({ type: 'star' });
    expect(count).toBe(0);
  });

  it('does not delete a sticky notification', async () => {
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    const doc = await Notification.findOne({ type: 'verify_email' });
    await service.dismiss(OWNER, doc!._id.toString());
    const count = await Notification.countDocuments({ type: 'verify_email' });
    expect(count).toBe(1);
  });
});

describe('listNotifications', () => {
  it('returns notifications and unreadCount', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    const { notifications, unreadCount } = await service.listNotifications(OWNER);
    expect(notifications).toHaveLength(2);
    expect(unreadCount).toBe(2);
  });
});

describe('markRead', () => {
  it('marks specified notifications as read', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    const doc = await Notification.findOne({ type: 'star' });
    await service.markRead(OWNER, [doc!._id.toString()]);
    const updated = await Notification.findById(doc!._id);
    expect(updated!.read).toBe(true);
  });

  it('does not mark another user\'s notifications as read', async () => {
    const OTHER = new mongoose.Types.ObjectId().toString();
    await service.upsertSocial({ ownerId: OTHER, type: 'star', projectId: PROJECT_ID, projectTitle: 'Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    const doc = await Notification.findOne({ type: 'star' });
    await service.markRead(OWNER, [doc!._id.toString()]); // OWNER tries to mark OTHER's notification
    const unchanged = await Notification.findById(doc!._id);
    expect(unchanged!.read).toBe(false);
  });
});

describe('markAllRead', () => {
  it('marks all unread notifications as read for the user', async () => {
    await service.upsertSocial({ ownerId: OWNER, type: 'star', projectId: PROJECT_ID, projectTitle: 'Song', actorId: ACTOR, actorAccountName: 'alice', actorAvatarUrl: null });
    await service.createOnce({ userId: OWNER, type: 'verify_email', sticky: true });
    await service.markAllRead(OWNER);
    const unread = await Notification.countDocuments({ userId: new mongoose.Types.ObjectId(OWNER), read: false });
    expect(unread).toBe(0);
  });
});
