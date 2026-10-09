/**
 * Ban, shadow-ban and appeal mutations in admin.service.
 *
 * Route-level authz (permission + sudo) is declared in admin.routes.ts and
 * covered by auth.ban.test.ts; what matters here is the second, service-level
 * layer security.md requires — rank enforcement — plus the IP/device side
 * effects and the cleanup done on unban.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({
  getIO: () => { throw new Error('no socket in tests'); },
}));
vi.mock('../notifications/notifications.service.js', () => ({
  createOnce: async () => undefined,
  notifyUnban: async () => undefined,
  notifyRoleChanged: async () => undefined,
  notifyXpChanged: async () => undefined,
}));
vi.mock('../email/email.service.js', () => ({ sendBanEmail: async () => undefined }));

import User from '../../db/user.model.js';
import AdminLog from './adminLog.model.js';
import BannedIp from './bannedIp.model.js';
import BannedDevice from './bannedDevice.model.js';
import UserDevice from '../auth/userDevice.model.js';
import { toggleBan, toggleShadowBan, rejectAppeal } from './admin.service.js';

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
  await Promise.all([
    User.deleteMany({}), AdminLog.deleteMany({}),
    BannedIp.deleteMany({}), BannedDevice.deleteMany({}), UserDevice.deleteMany({}),
  ]);
});

let n = 0;
async function mkUser(role = 'user', opts: { lastIp?: string; email?: string } = {}): Promise<string> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `adm${n}`,
    email: opts.email ?? `adm${n}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    role,
    permissions: [],
    lastIp: opts.lastIp ?? null,
    ban: { active: false, reason: null, until: null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
    shadowBan: { feed: false, search: false, reason: null, appliedAt: null, appliedBy: null },
  });
  return res.insertedId.toString();
}

type BanDoc = {
  ban?: { active?: boolean; reason?: string | null; until?: Date | null };
  appeal?: { status?: string; text?: string | null };
  shadowBan?: { feed?: boolean; search?: boolean; reason?: string | null; appliedBy?: unknown };
};
const read = (id: string) => User.findById(id).lean<BanDoc>();

describe('toggleBan — rank enforcement', () => {
  it('lets an admin ban an ordinary user', async () => {
    const admin = await mkUser('admin');
    const target = await mkUser('user');
    const res = await toggleBan(target, true, 'spam', null, false, false, admin);
    expect(res.error).toBeUndefined();
    expect((await read(target))?.ban?.active).toBe(true);
  });

  it('refuses a mod acting on an admin', async () => {
    const mod = await mkUser('mod');
    const target = await mkUser('admin');
    const res = await toggleBan(target, true, 'nope', null, false, false, mod);
    expect(res.status).toBe(403);
    expect((await read(target))?.ban?.active).toBe(false);
  });

  it('refuses action on a peer of equal rank', async () => {
    const a = await mkUser('admin');
    const b = await mkUser('admin');
    const res = await toggleBan(b, true, 'nope', null, false, false, a);
    expect(res.status).toBe(403);
  });

  it('refuses self-ban — self is always equal rank', async () => {
    const admin = await mkUser('admin');
    const res = await toggleBan(admin, true, 'oops', null, false, false, admin);
    expect(res.status).toBe(403);
  });

  it('treats a null actor as system and allows the action', async () => {
    const target = await mkUser('admin');
    const res = await toggleBan(target, true, 'automated', null, false, false, null);
    expect(res.error).toBeUndefined();
  });

  it('404s an unknown target', async () => {
    const admin = await mkUser('admin');
    const res = await toggleBan(new mongoose.Types.ObjectId().toString(), true, null, null, false, false, admin);
    expect(res.status).toBe(404);
  });
});

describe('toggleBan — ban payload', () => {
  it('stores reason and expiry', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    const until = new Date(Date.now() + 86_400_000);
    await toggleBan(target, true, 'harassment', until.toISOString(), false, false, admin);
    const doc = await read(target);
    expect(doc?.ban?.reason).toBe('harassment');
    expect(doc?.ban?.until?.toISOString()).toBe(until.toISOString());
  });

  it('writes an AdminLog entry attributed to the actor', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleBan(target, true, 'spam', null, false, false, admin);
    const logs = await AdminLog.find({ targetId: target }).lean<{ action: string }[]>();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.action.includes('ban'))).toBe(true);
  });
});

describe('toggleBan — IP and device side effects', () => {
  it('bans the last known IP when banIp is set', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user', { lastIp: '203.0.113.50' });
    await toggleBan(target, true, 'evasion', null, true, false, admin);
    const row = await BannedIp.findOne({ ip: '203.0.113.50' }).lean<{ userId?: unknown }>();
    expect(row).toBeTruthy();
    expect(row?.userId?.toString()).toBe(target);
  });

  it('never bans a loopback address', async () => {
    const admin = await mkUser('superadmin');
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const target = await mkUser('user', { lastIp: ip });
      await toggleBan(target, true, 'evasion', null, true, false, admin);
      expect(await BannedIp.findOne({ ip }).lean()).toBeNull();
    }
  });

  it('does not touch the IP table when banIp is false', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user', { lastIp: '203.0.113.51' });
    await toggleBan(target, true, 'spam', null, false, false, admin);
    expect(await BannedIp.countDocuments({})).toBe(0);
  });

  it('bans every device the user has been seen on', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await UserDevice.create([
      { deviceId: 'd1', userId: target, lastSeen: new Date() },
      { deviceId: 'd2', userId: target, lastSeen: new Date() },
    ]);
    await toggleBan(target, true, 'evasion', null, false, true, admin);
    const banned = await BannedDevice.find({}).lean<{ deviceId: string }[]>();
    expect(banned.map((d) => d.deviceId).sort()).toEqual(['d1', 'd2']);
  });

  it('is idempotent — re-banning the same IP upserts rather than duplicating', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user', { lastIp: '203.0.113.52' });
    await toggleBan(target, true, 'evasion', null, true, false, admin);
    await toggleBan(target, false, null, null, false, false, admin);
    await toggleBan(target, true, 'evasion again', null, true, false, admin);
    expect(await BannedIp.countDocuments({ ip: '203.0.113.52' })).toBe(1);
  });
});

describe('toggleBan — unban', () => {
  it('clears ban state and resets the appeal', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleBan(target, true, 'spam', null, false, false, admin);
    await User.updateOne({ _id: target }, { $set: { 'appeal.status': 'pending', 'appeal.text': 'sorry' } });

    await toggleBan(target, false, null, null, false, false, admin);
    const doc = await read(target);
    expect(doc?.ban?.active).toBe(false);
    expect(doc?.ban?.reason).toBeNull();
    expect(doc?.appeal?.status).toBe('none');
    expect(doc?.appeal?.text).toBeNull();
  });

  it('releases the IP and device bans it created for that user', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user', { lastIp: '203.0.113.60' });
    await UserDevice.create({ deviceId: 'd9', userId: target, lastSeen: new Date() });
    await toggleBan(target, true, 'evasion', null, true, true, admin);
    expect(await BannedIp.countDocuments({})).toBe(1);
    expect(await BannedDevice.countDocuments({})).toBe(1);

    await toggleBan(target, false, null, null, false, false, admin);
    expect(await BannedIp.countDocuments({})).toBe(0);
    expect(await BannedDevice.countDocuments({})).toBe(0);
  });

  it('leaves manually added network bans alone — they carry no userId', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user', { lastIp: '203.0.113.61' });
    await BannedIp.create({ ip: '198.51.100.99', reason: 'manual block', userId: null });
    await toggleBan(target, true, 'evasion', null, true, false, admin);
    await toggleBan(target, false, null, null, false, false, admin);

    expect(await BannedIp.findOne({ ip: '198.51.100.99' }).lean()).toBeTruthy();
    expect(await BannedIp.findOne({ ip: '203.0.113.61' }).lean()).toBeNull();
  });

  it('does not release another banned user sharing the same IP', async () => {
    const admin = await mkUser('superadmin');
    const a = await mkUser('user', { lastIp: '203.0.113.70' });
    const b = await mkUser('user', { lastIp: '203.0.113.71' });
    await toggleBan(a, true, 'evasion', null, true, false, admin);
    await toggleBan(b, true, 'evasion', null, true, false, admin);

    await toggleBan(a, false, null, null, false, false, admin);
    expect(await BannedIp.findOne({ ip: '203.0.113.71' }).lean()).toBeTruthy();
  });
});

describe('toggleShadowBan', () => {
  it('sets the two switches independently', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleShadowBan(target, true, false, 'brigading', admin);
    const doc = await read(target);
    expect(doc?.shadowBan).toMatchObject({ feed: true, search: false, reason: 'brigading' });
  });

  it('records who applied it', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleShadowBan(target, true, true, 'spam', admin);
    expect((await read(target))?.shadowBan?.appliedBy?.toString()).toBe(admin);
  });

  it('clears reason and attribution when both switches go off', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleShadowBan(target, true, true, 'spam', admin);
    await toggleShadowBan(target, false, false, null, admin);
    const doc = await read(target);
    expect(doc?.shadowBan).toMatchObject({ feed: false, search: false, reason: null, appliedBy: null });
  });

  it('enforces rank like a hard ban does', async () => {
    const mod = await mkUser('mod');
    const target = await mkUser('admin');
    const res = await toggleShadowBan(target, true, true, 'nope', mod);
    expect(res.status).toBe(403);
    expect((await read(target))?.shadowBan?.feed).toBe(false);
  });

  it('leaves the hard ban untouched', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleShadowBan(target, true, true, 'spam', admin);
    expect((await read(target))?.ban?.active).toBe(false);
  });
});

describe('rejectAppeal', () => {
  it('marks the appeal rejected and stamps a resolution time', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleBan(target, true, 'spam', null, false, false, admin);
    await User.updateOne({ _id: target }, { $set: { 'appeal.status': 'pending', 'appeal.text': 'sorry' } });

    const res = await rejectAppeal(target, admin);
    expect(res.success).toBe(true);
    expect((await read(target))?.appeal?.status).toBe('rejected');
  });

  it('leaves the ban in place', async () => {
    const admin = await mkUser('superadmin');
    const target = await mkUser('user');
    await toggleBan(target, true, 'spam', null, false, false, admin);
    await rejectAppeal(target, admin);
    expect((await read(target))?.ban?.active).toBe(true);
  });

  /**
   * FINDING F — rejectAppeal is the one staff action with no rank guard.
   *
   * toggleBan, toggleShadowBan and changeUserRole all call actorRank() and
   * refuse a target of equal or higher rank. rejectAppeal does not, so a mod
   * can resolve a superadmin's appeal. Low impact, but it is the only hole in
   * an otherwise uniform pattern — and uniformity is what makes the pattern
   * reviewable.
   *
   * Remove the `.fails` marker once the guard is added.
   */
  it.fails('should refuse a mod rejecting a superadmin appeal (FINDING F)', async () => {
    const mod = await mkUser('mod');
    const target = await mkUser('superadmin');
    const res = await rejectAppeal(target, mod);
    expect(res.status).toBe(403);
  });
});
