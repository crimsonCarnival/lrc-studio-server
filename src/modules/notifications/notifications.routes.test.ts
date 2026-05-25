import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import notificationsRoutes from './notifications.routes.js';
import Notification from './notification.model.js';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: vi.fn(() => ({ to: vi.fn().mockReturnThis(), emit: vi.fn() })),
}));

let mongoServer: MongoMemoryServer;
const USER_ID = new mongoose.Types.ObjectId();

async function buildApp() {
  const app = Fastify();
  await app.register(fastifyCookie);
  app.decorate('requireAuth', async (req: any) => { req.userId = USER_ID.toString(); });
  await app.register(notificationsRoutes, { prefix: '/notifications' });
  return app;
}

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

describe('GET /notifications', () => {
  it('returns notifications and unreadCount', async () => {
    await Notification.create({ userId: USER_ID, type: 'system', read: false, sticky: false, body: 'Hello', actors: [], actorCount: 0 });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/notifications' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.unreadCount).toBe(1);
  });
});

describe('DELETE /notifications/:id on sticky', () => {
  it('returns 200 without deleting the sticky document', async () => {
    const doc = await Notification.create({ userId: USER_ID, type: 'verify_email', read: false, sticky: true, body: null, actors: [], actorCount: 0 });
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/notifications/${doc._id}` });
    expect(res.statusCode).toBe(200);
    const count = await Notification.countDocuments({ _id: doc._id });
    expect(count).toBe(1);
  });
});

describe('POST /notifications/read', () => {
  it('marks specified notifications as read and returns 200', async () => {
    const doc = await Notification.create({ userId: USER_ID, type: 'system', read: false, sticky: false, body: 'Hello', actors: [], actorCount: 0 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/read',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ids: [doc._id.toString()] }),
    });
    expect(res.statusCode).toBe(200);
    const updated = await Notification.findById(doc._id);
    expect(updated!.read).toBe(true);
  });
});

describe('POST /notifications/read-all', () => {
  it('marks all notifications as read and returns 200', async () => {
    await Notification.create({ userId: USER_ID, type: 'system', read: false, sticky: false, body: 'Hello', actors: [], actorCount: 0 });
    await Notification.create({ userId: USER_ID, type: 'admin', read: false, sticky: false, body: 'World', actors: [], actorCount: 0 });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/notifications/read-all' });
    expect(res.statusCode).toBe(200);
    const unread = await Notification.countDocuments({ userId: USER_ID, read: false });
    expect(unread).toBe(0);
  });
});
