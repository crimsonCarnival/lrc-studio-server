import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mockSuperadminEmail: string | undefined;
vi.mock('../../config/env.js', () => ({
  getEnv: () => ({ SUPERADMIN_EMAIL: mockSuperadminEmail }),
}));

import User from '../../db/user.model.js';
import AdminLog from '../admin/adminLog.model.js';
import { ROLE_PRESETS } from '../../shared/permissions.js';
import { grantSuperadminIfEnvMatch, syncSuperadminEmailGrant, isSuperadminEmail } from './superadmin-env.service.js';

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
  mockSuperadminEmail = undefined;
  await Promise.all([User.deleteMany({}), AdminLog.deleteMany({})]);
});

let n = 0;
// Raw insert (bypasses Mongoose subdocument defaults) — matches
// admin/permissions.test.ts's pattern and avoids every inserted user
// getting an identical `google.googleId: null`, which collides with the
// sparse unique index on that field when creating more than one user.
async function mkUser(role: string, email: string): Promise<{ id: string; role: string; email: string }> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `user${n}`, email, passwordHash: 'x', isDeleted: false, role, permissions: [],
    ban: { active: false },
  });
  return { id: res.insertedId.toString(), role, email };
}

describe('isSuperadminEmail', () => {
  it('is false when SUPERADMIN_EMAIL is unset', () => {
    expect(isSuperadminEmail('a@x.test')).toBe(false);
  });

  it('matches case-insensitively, exact only', () => {
    mockSuperadminEmail = 'Admin@Example.com';
    expect(isSuperadminEmail('admin@example.com')).toBe(true);
    expect(isSuperadminEmail('ADMIN@EXAMPLE.COM')).toBe(true);
    expect(isSuperadminEmail('other@example.com')).toBe(false);
    expect(isSuperadminEmail('admin@example.com.evil.com')).toBe(false);
  });

  it('is false when the configured value is empty/whitespace', () => {
    mockSuperadminEmail = '   ';
    expect(isSuperadminEmail('anyone@x.test')).toBe(false);
  });

  it('accepts a comma-separated list, matching any entry case-insensitively', () => {
    mockSuperadminEmail = 'Admin@Example.com, second@x.test,  third@x.test ';
    expect(isSuperadminEmail('admin@example.com')).toBe(true);
    expect(isSuperadminEmail('second@x.test')).toBe(true);
    expect(isSuperadminEmail('THIRD@X.TEST')).toBe(true);
    expect(isSuperadminEmail('fourth@x.test')).toBe(false);
  });

  it('ignores empty entries from stray/trailing commas', () => {
    mockSuperadminEmail = 'a@x.test,,  ,b@x.test,';
    expect(isSuperadminEmail('a@x.test')).toBe(true);
    expect(isSuperadminEmail('b@x.test')).toBe(true);
    expect(isSuperadminEmail('')).toBe(false);
  });
});

describe('grantSuperadminIfEnvMatch', () => {
  it('no-ops when SUPERADMIN_EMAIL is unset — never grants to nobody', async () => {
    const { id } = await mkUser('user', 'a@x.test');
    const doc = await User.findById(id);
    const granted = await grantSuperadminIfEnvMatch(doc!);
    expect(granted).toBe(false);
    expect(doc!.role).toBe('user');
    expect(await AdminLog.countDocuments()).toBe(0);
  });

  it('grants superadmin and the full permission preset when the email matches', async () => {
    mockSuperadminEmail = 'boss@x.test';
    const { id } = await mkUser('user', 'boss@x.test');
    const doc = await User.findById(id);
    const granted = await grantSuperadminIfEnvMatch(doc!);
    expect(granted).toBe(true);
    expect(doc!.role).toBe('superadmin');
    expect(doc!.permissions).toEqual(ROLE_PRESETS.superadmin);

    const fromDb = await User.findById(id).lean();
    expect(fromDb?.role).toBe('superadmin');
    expect(fromDb?.permissions).toEqual(ROLE_PRESETS.superadmin);
  });

  it('writes exactly one system-attributed audit log entry on grant', async () => {
    mockSuperadminEmail = 'boss@x.test';
    const { id } = await mkUser('user', 'boss@x.test');
    const doc = await User.findById(id);
    await grantSuperadminIfEnvMatch(doc!);

    const logs = await AdminLog.find({ action: 'grant_superadmin_env' }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0].adminName).toBe('system:SUPERADMIN_EMAIL');
    expect(logs[0].targetId?.toString()).toBe(id);
    expect(logs[0].details).toContain('superadmin');
  });

  it('is idempotent: a second call on an already-granted user is a no-op and does not duplicate the log', async () => {
    mockSuperadminEmail = 'boss@x.test';
    const { id } = await mkUser('user', 'boss@x.test');
    const doc = await User.findById(id);
    await grantSuperadminIfEnvMatch(doc!);
    const second = await grantSuperadminIfEnvMatch(doc!);

    expect(second).toBe(false);
    expect(await AdminLog.countDocuments({ action: 'grant_superadmin_env' })).toBe(1);
  });

  it('does not touch a user whose email does not match', async () => {
    mockSuperadminEmail = 'boss@x.test';
    const { id } = await mkUser('user', 'other@x.test');
    const doc = await User.findById(id);
    const granted = await grantSuperadminIfEnvMatch(doc!);
    expect(granted).toBe(false);
    expect(doc!.role).toBe('user');
    expect(await AdminLog.countDocuments()).toBe(0);
  });
});

describe('syncSuperadminEmailGrant (startup job)', () => {
  it('no-ops when SUPERADMIN_EMAIL is unset', async () => {
    await mkUser('user', 'boss@x.test');
    await syncSuperadminEmailGrant();
    const updated = await User.findOne({ email: 'boss@x.test' }).lean();
    expect(updated?.role).toBe('user');
  });

  it('no-ops when no user matches the configured email — never grants to everybody', async () => {
    mockSuperadminEmail = 'nobody@x.test';
    await mkUser('user', 'someone@x.test');
    await syncSuperadminEmailGrant();
    const updated = await User.findOne({ email: 'someone@x.test' }).lean();
    expect(updated?.role).toBe('user');
  });

  it('promotes the matching existing user', async () => {
    mockSuperadminEmail = 'boss@x.test';
    await mkUser('user', 'boss@x.test');
    await syncSuperadminEmailGrant();
    const updated = await User.findOne({ email: 'boss@x.test' }).lean();
    expect(updated?.role).toBe('superadmin');
    expect(updated?.permissions).toEqual(ROLE_PRESETS.superadmin);
  });

  it('does not demote an existing superadmin when the env var later points at a different email', async () => {
    mockSuperadminEmail = 'old-boss@x.test';
    const oldBoss = await mkUser('superadmin', 'old-boss@x.test');
    await User.updateOne({ _id: oldBoss.id }, { $set: { permissions: [...ROLE_PRESETS.superadmin] } });

    // Env reconfigured to a different email — old superadmin must be left alone.
    mockSuperadminEmail = 'new-boss@x.test';
    await mkUser('user', 'new-boss@x.test');
    await syncSuperadminEmailGrant();

    const stillBoss = await User.findById(oldBoss.id).lean();
    expect(stillBoss?.role).toBe('superadmin');

    const newBoss = await User.findOne({ email: 'new-boss@x.test' }).lean();
    expect(newBoss?.role).toBe('superadmin');
  });

  it('does not re-log when the matching user is already superadmin', async () => {
    mockSuperadminEmail = 'boss@x.test';
    const boss = await mkUser('superadmin', 'boss@x.test');
    await User.updateOne({ _id: boss.id }, { $set: { permissions: [...ROLE_PRESETS.superadmin] } });

    await syncSuperadminEmailGrant();
    expect(await AdminLog.countDocuments({ action: 'grant_superadmin_env' })).toBe(0);
  });

  it('promotes every existing user matching a comma-separated list, and none of the unmatched ones', async () => {
    mockSuperadminEmail = 'first@x.test, second@x.test';
    await mkUser('user', 'first@x.test');
    await mkUser('user', 'second@x.test');
    await mkUser('user', 'third@x.test');

    await syncSuperadminEmailGrant();

    expect((await User.findOne({ email: 'first@x.test' }).lean())?.role).toBe('superadmin');
    expect((await User.findOne({ email: 'second@x.test' }).lean())?.role).toBe('superadmin');
    expect((await User.findOne({ email: 'third@x.test' }).lean())?.role).toBe('user');
    expect(await AdminLog.countDocuments({ action: 'grant_superadmin_env' })).toBe(2);
  });
});
