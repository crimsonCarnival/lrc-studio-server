import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import User from '../../db/user.model.js';
import StaffRequest from './request.model.js';
import BadgeDefinition from '../badges/badge-definition.model.js';
import AdminLog from '../admin/adminLog.model.js';
import Notification from '../notifications/notification.model.js';
import { createRequest, reviewRequest, submittableTypes } from './request.service.js';

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
  await Promise.all([User.deleteMany({}), StaffRequest.deleteMany({}), BadgeDefinition.deleteMany({}), AdminLog.deleteMany({}), Notification.deleteMany({})]);
});

let n = 0;
async function mkUser(permissions: string[]): Promise<{ userId: string; permissions: string[]; name: string }> {
  n++;
  const res = await User.collection.insertOne({
    accountName: `u${n}`, email: `u${n}@x.test`, passwordHash: 'x', isDeleted: false, role: 'user', permissions,
    ban: { active: false },
  });
  return { userId: res.insertedId.toString(), permissions, name: `u${n}` };
}

const ADMIN = ['users.view', 'users.ban', 'network.block', 'users.role'];
const badgeInput = { id: 'new_badge', label: { en: 'New' }, color: 'teal', conditionType: 'manual' };
const flush = () => new Promise(r => setTimeout(r, 50));

describe('staff requests', () => {
  it('only staff without the manage permission can submit', async () => {
    const plain = await mkUser([]);
    const manager = await mkUser(['badges.manage']);
    await expect(createRequest(plain, 'badge_create', { input: badgeInput })).rejects.toMatchObject({ status: 403 });
    await expect(createRequest(manager, 'badge_create', { input: badgeInput })).rejects.toMatchObject({ status: 403 });
    expect(submittableTypes(ADMIN)).toContain('badge_create');
    expect(submittableTypes(ADMIN)).not.toContain('block_ip');
  });

  it('whitelists payload fields and rejects invalid input', async () => {
    const admin = await mkUser(ADMIN);
    const doc = await createRequest(admin, 'badge_create', { input: { ...badgeInput, isBuiltin: true, createdBy: 'x' }, extra: 1 });
    const stored = await StaffRequest.findById(doc._id).lean();
    expect(stored?.payload).toEqual({ input: { id: 'new_badge', label: { en: 'New' }, color: 'teal', conditionType: 'manual' } });
    await expect(createRequest(admin, 'badge_create', { input: { ...badgeInput, color: '#fff' } })).rejects.toMatchObject({ status: 400 });
    await expect(createRequest(admin, 'badge_update', { id: 'x', input: { ...badgeInput, label: { en: 'a'.repeat(51) } } })).rejects.toMatchObject({ status: 400 });
    await flush();
    expect(await AdminLog.countDocuments({ action: 'submit_request' })).toBe(1);
  });

  it('approve re-checks permission, executes once, logs and notifies', async () => {
    const admin = await mkUser(ADMIN);
    const noPerm = await mkUser(['users.view']);
    const reviewer = await mkUser(['badges.manage']);
    const doc = await createRequest(admin, 'badge_create', { input: badgeInput });
    const id = doc._id.toString();

    await expect(reviewRequest(noPerm, id, 'approve')).rejects.toMatchObject({ status: 403 });
    await expect(reviewRequest({ ...admin, permissions: [...ADMIN, 'badges.manage'] }, id, 'approve')).rejects.toMatchObject({ status: 403 });

    const results = await Promise.allSettled([reviewRequest(reviewer, id, 'approve'), reviewRequest(reviewer, id, 'approve')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await BadgeDefinition.countDocuments({ id: 'new_badge' })).toBe(1);
    await expect(reviewRequest(reviewer, id, 'reject')).rejects.toMatchObject({ status: 409 });

    const stored = await StaffRequest.findById(id).lean();
    expect(stored?.status).toBe('approved');
    expect(stored?.reviewer?.id?.toString()).toBe(reviewer.userId);
    await flush();
    expect(await AdminLog.countDocuments({ action: 'create_badge', adminId: reviewer.userId })).toBe(1);
    expect(await AdminLog.countDocuments({ action: 'approve_request' })).toBe(1);
    expect(await Notification.countDocuments({ userId: admin.userId, type: 'request_reviewed' })).toBe(1);
  });

  it('reject stores the note; failed execution releases the claim', async () => {
    const admin = await mkUser(ADMIN);
    const reviewer = await mkUser(['badges.manage', 'levels.manage']);
    const a = await createRequest(admin, 'badge_delete', { id: 'nope' });
    const rejected = await reviewRequest(reviewer, a._id.toString(), 'reject', '  not needed ');
    expect(rejected.status).toBe('rejected');
    expect(rejected.decisionNote).toBe('not needed');

    const b = await createRequest(admin, 'level_update', { id: 'missing', input: { order: 3 } });
    await expect(reviewRequest(reviewer, b._id.toString(), 'approve')).rejects.toThrow('Level not found');
    const stored = await StaffRequest.findById(b._id).lean();
    expect(stored?.status).toBe('pending');
    expect(stored?.error).toBe('Level not found');
    expect(stored?.resolvedAt).toBeNull();
  });

  it('re-validates a stored payload at approval time', async () => {
    const admin = await mkUser(ADMIN);
    const reviewer = await mkUser(['badges.manage']);
    const doc = await createRequest(admin, 'badge_create', { input: badgeInput });
    await StaffRequest.collection.updateOne({ _id: doc._id }, { $set: { 'payload.input.color': 'evil' } });
    await expect(reviewRequest(reviewer, doc._id.toString(), 'approve')).rejects.toMatchObject({ status: 400 });
    expect(await BadgeDefinition.countDocuments({})).toBe(0);
    expect((await StaffRequest.findById(doc._id).lean())?.status).toBe('pending');
  });
  it('approving a sudo-protected type requires sudo; rejecting does not', async () => {
    const mod = await mkUser(['users.view', 'users.ban']);
    const reviewer = await mkUser(['network.block']);
    const a = await createRequest(mod, 'block_ip', { ip: '10.0.0.99' });
    await expect(reviewRequest(reviewer, a._id.toString(), 'approve')).rejects.toMatchObject({ code: 'SUDO_REQUIRED' });
    expect((await StaffRequest.findById(a._id).lean())?.status).toBe('pending');
    const ok = await reviewRequest({ ...reviewer, hasSudo: true }, a._id.toString(), 'approve');
    expect(ok.status).toBe('approved');

    const b = await createRequest(mod, 'xp_adjust', { action: 'grant', amount: 5, target: 'all' });
    expect((await reviewRequest({ ...(await mkUser(['xp.adjust'])) }, b._id.toString(), 'reject')).status).toBe('rejected');
  });
});
