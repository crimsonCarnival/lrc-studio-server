/** listPendingAppeals: only banned users with a pending appeal, oldest first, no secrets. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../users/user.model.js';
import { listPendingAppeals } from './admin.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => { await User.deleteMany({}); });

let n = 0;
async function mkUser(ban: boolean, appeal: 'none' | 'pending' | 'rejected', submittedAt: Date | null) {
  n++;
  await User.collection.insertOne({
    accountName: `ap${n}`,
    email: `ap${n}@x.test`,
    passwordHash: 'secret-hash',
    isDeleted: false,
    role: 'user',
    permissions: [],
    ban: { active: ban, reason: 'spam', until: null },
    appeal: { text: `please ${n}`, status: appeal, submittedAt, resolvedAt: null },
  });
}

describe('listPendingAppeals', () => {
  it('returns only banned users with a pending appeal, oldest first', async () => {
    await mkUser(true, 'pending', new Date('2026-01-03'));
    await mkUser(true, 'pending', new Date('2026-01-01'));
    await mkUser(true, 'rejected', new Date('2026-01-02'));
    await mkUser(false, 'pending', new Date('2026-01-02'));
    await mkUser(true, 'none', null);

    const { appeals, total } = await listPendingAppeals();
    expect(total).toBe(2);
    expect(appeals.map(a => a.accountName)).toEqual(['ap2', 'ap1']);
  });

  it('never exposes the password hash', async () => {
    await mkUser(true, 'pending', new Date());
    const { appeals } = await listPendingAppeals();
    expect(JSON.stringify(appeals)).not.toContain('secret-hash');
    expect(appeals[0]).toMatchObject({ ban: { reason: 'spam' }, appeal: { text: expect.any(String), status: 'pending' } });
  });
});
