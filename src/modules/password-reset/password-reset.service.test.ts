/**
 * Password reset / change must (a) consume exactly the link that was used,
 * and (b) evict other sessions, since both are account-recovery paths.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../email/email.service.js', () => ({
  sendPasswordResetEmail: async () => undefined,
  sendPasswordChangedEmail: async () => undefined,
}));
vi.mock('../notifications/notifications.service.js', () => ({
  createOnce: async () => undefined,
  resolveSticky: async () => undefined,
}));

import User from '../users/user.model.js';
import Session from '../auth/session.model.js';
import PasswordReset from './password-reset.model.js';
import { resetPassword, changePassword, PasswordResetError } from './password-reset.service.js';

let repl: MongoMemoryReplSet;
const EMAIL = 'reset@x.test';
const OLD_PASSWORD = 'Old-Password-1!';
let userId: string;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([User.init(), Session.init(), PasswordReset.init()]);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Session.deleteMany({}), PasswordReset.deleteMany({})]);
  const res = await User.collection.insertOne({
    accountName: 'resetuser',
    email: EMAIL,
    passwordHash: await User.hashPassword(OLD_PASSWORD),
    role: 'user',
    permissions: [],
    ban: { active: false, reason: null, until: null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
  });
  userId = res.insertedId.toString();
}, 60_000);

async function issueLink(): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await PasswordReset.create({
    email: EMAIL,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 30 * 60_000),
    isUsed: false,
  });
  return token;
}

async function mkSession(familyId: string) {
  await Session.create({ userId, familyId, refreshTokenHash: familyId, expiresAt: new Date(Date.now() + 3600_000) });
}

describe('resetPassword', () => {
  it('consumes the link that was used, even when it is not the oldest', async () => {
    await issueLink();
    const second = await issueLink();
    await resetPassword(second, 'New-Password-2!');
    await expect(resetPassword(second, 'New-Password-3!')).rejects.toBeInstanceOf(PasswordResetError);
  }, 60_000);

  it('invalidates every other outstanding link for the address', async () => {
    const first = await issueLink();
    const second = await issueLink();
    await resetPassword(second, 'New-Password-2!');
    await expect(resetPassword(first, 'New-Password-3!')).rejects.toBeInstanceOf(PasswordResetError);
  }, 60_000);

  it('revokes every session', async () => {
    await mkSession('a');
    await mkSession('b');
    await resetPassword(await issueLink(), 'New-Password-2!');
    expect(await Session.countDocuments({ userId, isValid: true })).toBe(0);
  }, 60_000);
});

describe('changePassword', () => {
  it('revokes other sessions but keeps the caller\'s own', async () => {
    await mkSession('mine');
    await mkSession('other');
    await changePassword(userId, OLD_PASSWORD, 'New-Password-2!', false, 'mine');
    const live = await Session.find({ userId, isValid: true }).lean();
    expect(live.map(s => s.familyId)).toEqual(['mine']);
  }, 60_000);
});
