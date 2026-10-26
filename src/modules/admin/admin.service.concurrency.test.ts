import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// admin.service.ts's user.save() call sites were switched to targeted
// User.updateOne({_id}, {$set: {...}}) calls. That is a narrower, cheaper
// write (skips loading and hydrating the full document for a one- or
// two-field update) — it is NOT a concurrency fix. Verified directly before
// writing this: Mongoose's save() already scopes its update to only the
// paths actually assigned on that specific document instance (its
// dirty-path tracking), so two concurrent admin actions on different
// fields of the same user — a ban racing a role change — already landed
// both effects correctly under the old save()-based code too. This test
// documents that the switch preserved that correctness, not that it
// introduced it.
vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../notifications/notifications.service.js', () => ({
  createOnce: async () => undefined,
  notifyRoleChanged: async () => undefined,
  notifyXpChanged: async () => undefined,
  notifyUnban: async () => undefined,
}));
vi.mock('../email/email.service.js', () => ({ sendBanEmail: async () => undefined }));

import User from '../users/user.model.js';
import AdminLog from './admin-log.model.js';
import { toggleBan, changeUserRole } from './admin.service.js';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AdminLog.deleteMany({})]);
});

let seq = 0;
async function mkUser(): Promise<string> {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({
    accountName: `concurtest${n}`, email: `concurtest${n}@x.test`, passwordHash: 'x',
    role: 'user', permissions: [],
    ban: { active: false, reason: null, until: null },
    appeal: { text: null, status: 'none', submittedAt: null, resolvedAt: null },
  });
  return insertedId.toString();
}

describe('admin.service — targeted updates on the same user', () => {
  it('a ban and a role change on different fields both land, concurrently or not', async () => {
    const userId = await mkUser();

    const [banResult, roleResult] = await Promise.all([
      toggleBan(userId, true, 'test reason', null, false, false, null),
      changeUserRole(userId, 'mod', null),
    ]);
    expect(banResult.error).toBeUndefined();
    expect(roleResult.error).toBeUndefined();

    const after = await User.findById(userId).lean<{ ban: { active: boolean }; role: string; permissions: string[] }>();
    expect(after!.ban.active).toBe(true);
    expect(after!.role).toBe('mod');
    expect(after!.permissions.length).toBeGreaterThan(0); // reseeded for 'mod'
  });

  it('sequential writes to different fields do not revert each other', async () => {
    const userId = await mkUser();
    await changeUserRole(userId, 'mod', null);
    await toggleBan(userId, true, 'reason', null, false, false, null);

    const after = await User.findById(userId).lean<{ ban: { active: boolean }; role: string }>();
    expect(after!.role).toBe('mod'); // not reverted by the later ban
    expect(after!.ban.active).toBe(true);
  });
});
