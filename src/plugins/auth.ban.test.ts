/**
 * Ban enforcement in the auth decorators.
 *
 * These are the only place account / IP / device bans are enforced for REST,
 * and `optionalAuth` is also what builds the GraphQL context (server.ts) — so
 * whatever `optionalAuth` fails to check is unchecked for the entire data
 * graph. The `/ctx` route below mirrors that context build deliberately.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import authPlugin from './auth.js';
import User from '../db/user.model.js';
import BannedIp from '../modules/admin/bannedIp.model.js';
import BannedDevice from '../modules/admin/bannedDevice.model.js';

let mongo: MongoMemoryServer;
let app: FastifyInstance;

const CLEAN_IP = '198.51.100.10';
const BAD_IP = '203.0.113.7';

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  app = Fastify();
  await app.register(fastifyCookie);
  await app.register(authPlugin);

  app.get('/auth-required', { preHandler: [app.requireAuth] }, async (req) => ({ userId: req.userId }));
  app.get('/staff', { preHandler: [app.requireStaff] }, async (req) => ({ userId: req.userId }));
  // Mirrors the GraphQL context build in server.ts:74 — same decorator, same
  // fields read off the request afterwards.
  app.get('/ctx', { preHandler: [app.optionalAuth] }, async (req) => {
    const r = req as FastifyRequest & { bannedUserId?: string; tokenExpired?: boolean };
    return { userId: r.userId ?? null, bannedUserId: r.bannedUserId ?? null, tokenExpired: r.tokenExpired ?? false };
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), BannedIp.deleteMany({}), BannedDevice.deleteMany({})]);
});

let n = 0;
type BanFields = { active: boolean; reason?: string | null; until?: Date | null };

async function mkUser(opts: {
  ban?: BanFields;
  permissions?: string[];
  role?: string;
  deletedAt?: Date | null;
} = {}): Promise<string> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `banuser${n}`,
    email: `banuser${n}@x.test`,
    passwordHash: 'x',
    isDeleted: !!opts.deletedAt,
    deletedAt: opts.deletedAt ?? null,
    role: opts.role ?? 'user',
    permissions: opts.permissions ?? [],
    ban: opts.ban ?? { active: false, reason: null, until: null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
  });
  return res.insertedId.toString();
}

function token(userId: string): string {
  return (app as unknown as { jwt: { signAccess(p: Record<string, unknown>): string } })
    .jwt.signAccess({ sub: userId });
}

function call(path: string, opts: { userId?: string; deviceId?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.deviceId) headers['x-device-id'] = opts.deviceId;
  return app.inject({
    method: 'GET',
    url: path,
    headers,
    cookies: opts.userId ? { accessToken: token(opts.userId) } : {},
    remoteAddress: opts.ip ?? CLEAN_IP,
  });
}

describe('requireAuth — account ban', () => {
  it('admits a clean authenticated user', async () => {
    const id = await mkUser();
    const res = await call('/auth-required', { userId: id });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe(id);
  });

  it('401s with no token at all', async () => {
    const res = await call('/auth-required');
    expect(res.statusCode).toBe(401);
  });

  it('403s an actively banned user', async () => {
    const id = await mkUser({ ban: { active: true, reason: 'spam', until: null } });
    const res = await call('/auth-required', { userId: id });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('User is banned');
  });

  it('401s a soft-deleted user before the ban check is even reached', async () => {
    const id = await mkUser({ deletedAt: new Date() });
    const res = await call('/auth-required', { userId: id });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('User not found');
  });

  it('self-expires a temporary ban and persists the cleared state', async () => {
    const id = await mkUser({
      ban: { active: true, reason: 'cooling off', until: new Date(Date.now() - 1000) },
    });
    const res = await call('/auth-required', { userId: id });
    expect(res.statusCode).toBe(200);

    // checkBanStatus() must have written the cleared ban back, not just
    // cleared it in memory for this one request.
    const after = await User.findById(id).lean<{ ban?: BanFields }>();
    expect(after?.ban?.active).toBe(false);
    expect(after?.ban?.reason).toBeNull();
  });

  it('keeps a future-dated ban active', async () => {
    const id = await mkUser({
      ban: { active: true, reason: 'spam', until: new Date(Date.now() + 60_000) },
    });
    const res = await call('/auth-required', { userId: id });
    expect(res.statusCode).toBe(403);
  });
});

describe('requireAuth — network bans', () => {
  it('403s a banned device id', async () => {
    const id = await mkUser();
    await BannedDevice.create({ deviceId: 'dev-bad', reason: 'evasion' });
    const res = await call('/auth-required', { userId: id, deviceId: 'dev-bad' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/this device/);
  });

  it('403s a banned IP', async () => {
    const id = await mkUser();
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await call('/auth-required', { userId: id, ip: BAD_IP });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/this network/);
  });

  it('does not ban a device by prefix or partial match', async () => {
    const id = await mkUser();
    await BannedDevice.create({ deviceId: 'dev-bad', reason: 'evasion' });
    const res = await call('/auth-required', { userId: id, deviceId: 'dev-bad-but-different' });
    expect(res.statusCode).toBe(200);
  });

  it('admits a clean user who sends no device header', async () => {
    const id = await mkUser();
    await BannedDevice.create({ deviceId: 'dev-bad', reason: 'evasion' });
    const res = await call('/auth-required', { userId: id });
    expect(res.statusCode).toBe(200);
  });
});

describe('requireStaff', () => {
  it('403s a user holding no permissions', async () => {
    const id = await mkUser({ role: 'user', permissions: [] });
    const res = await call('/staff', { userId: id });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('Staff access required');
  });

  it('admits a user holding at least one permission', async () => {
    const id = await mkUser({ role: 'mod', permissions: ['users.view'] });
    const res = await call('/staff', { userId: id });
    expect(res.statusCode).toBe(200);
  });

  it('403s a banned staff member — the ban outranks the permission', async () => {
    const id = await mkUser({
      role: 'admin',
      permissions: ['users.view', 'users.ban'],
      ban: { active: true, reason: 'compromised', until: null },
    });
    const res = await call('/staff', { userId: id });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('User is banned');
  });
});

describe('optionalAuth — the GraphQL context path', () => {
  it('populates userId for a clean user', async () => {
    const id = await mkUser();
    const res = await call('/ctx', { userId: id });
    expect(res.json()).toMatchObject({ userId: id, bannedUserId: null });
  });

  it('withholds userId from a banned user and flags bannedUserId instead', async () => {
    // This is what makes every GraphQL mutation throw Unauthorized for a
    // banned account: resolvers gate on context.userId, which stays null.
    const id = await mkUser({ ban: { active: true, reason: 'spam', until: null } });
    const res = await call('/ctx', { userId: id });
    expect(res.json()).toMatchObject({ userId: null, bannedUserId: id });
  });

  it('stays anonymous for an unauthenticated request', async () => {
    const res = await call('/ctx');
    expect(res.json()).toMatchObject({ userId: null, bannedUserId: null, tokenExpired: false });
  });

  /**
   * FINDING A — IP and device bans do not reach GraphQL.
   *
   * `optionalAuth` checks `deletedAt` and `ban.active` but never calls
   * checkDeviceBan/checkIpBan, and it is what builds the GraphQL context. Since
   * projects, stars, forks, boosts, reactions, playlists and follows are all
   * GraphQL, a user on a banned device or IP keeps full use of the product for
   * as long as their session lasts.
   *
   * Remove the `.fails` markers once optionalAuth checks the network bans.
   */
  it.fails('should withhold userId from a banned device (FINDING A)', async () => {
    const id = await mkUser();
    await BannedDevice.create({ deviceId: 'dev-bad', reason: 'evasion' });
    const res = await call('/ctx', { userId: id, deviceId: 'dev-bad' });
    expect(res.json().userId).toBeNull();
  });

  it.fails('should withhold userId from a banned IP (FINDING A)', async () => {
    const id = await mkUser();
    await BannedIp.create({ ip: BAD_IP, reason: 'evasion' });
    const res = await call('/ctx', { userId: id, ip: BAD_IP });
    expect(res.json().userId).toBeNull();
  });
});
