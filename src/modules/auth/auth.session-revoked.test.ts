import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Session from './session.model.js';
import { revokeAllSessions, revokeSession } from './auth.service.js';
import { setIO, sessionRoom } from '../../socket/socket.manager.js';

// "Sign out of other devices" once emitted `session:revoked` to the whole `user:` room, which
// includes the device that asked, so the client logged itself out. The notice must reach only
// the sockets of the sessions that were actually revoked.

let mongo: MongoMemoryServer;
const userId = new mongoose.Types.ObjectId();
const emitted: { rooms: string[]; event: string }[] = [];

const fakeIO = {
  to: (rooms: string | string[]) => ({
    emit: (event: string) => { emitted.push({ rooms: ([] as string[]).concat(rooms), event }); },
  }),
};

const mkSession = (familyId: string) =>
  Session.create({ userId, familyId, refreshTokenHash: `h-${familyId}`, expiresAt: new Date(Date.now() + 3_600_000) });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  setIO(fakeIO as never);
}, 60000);
afterAll(async () => {
  setIO(null);
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Session.deleteMany({});
  emitted.length = 0;
  vi.clearAllMocks();
});

describe('session:revoked targeting', () => {
  it('revoke-all-except notifies every other session and never the kept one', async () => {
    await mkSession('fam-here');
    await mkSession('fam-b');
    await mkSession('fam-c');

    await revokeAllSessions(userId.toString(), 'fam-here');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('session:revoked');
    expect([...emitted[0].rooms].sort()).toEqual([sessionRoom('fam-b'), sessionRoom('fam-c')]);
    expect(emitted[0].rooms).not.toContain(sessionRoom('fam-here'));
    expect(await Session.exists({ familyId: 'fam-here', isValid: true })).toBeTruthy();
  });

  it('does not notify anyone when there is nothing else to revoke', async () => {
    await mkSession('fam-here');
    await revokeAllSessions(userId.toString(), 'fam-here');
    expect(emitted).toHaveLength(0);
  });

  it('revoking one session notifies only that session', async () => {
    const target = await mkSession('fam-b');
    await mkSession('fam-here');

    await revokeSession(userId.toString(), target._id.toString());

    expect(emitted).toHaveLength(1);
    expect(emitted[0].rooms).toEqual([sessionRoom('fam-b')]);
  });
});
