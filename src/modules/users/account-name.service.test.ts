import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from './user.model.js';
import AccountNameHistory from './account-name-history.model.js';
import { findUserByAccountName, isAccountNameInHistoryOfOther, recordAccountNameChange, generateUniqueAccountName, accountNameBase } from './account-name.service.js';
import { isValidAccountName, isReservedAccountName } from '../auth/auth.validation.js';

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
  await Promise.all([User.deleteMany({}), AccountNameHistory.deleteMany({})]);
});

// The email is unique per call, not derived from the account name: one test
// deliberately creates two users who both held the name 'first' (one renamed
// away), which a name-derived email would reject on the unique email index
// before the scenario under test could run.
let userSeq = 0;
const mkUser = async (accountName: string) =>
  (await User.collection.insertOne({
    accountName,
    email: `${accountName}-${++userSeq}@x.test`,
    passwordHash: 'x',
  })).insertedId;

/** Mirrors what updateProfile does on a rename. */
async function rename(id: mongoose.Types.ObjectId, from: string, to: string) {
  await recordAccountNameChange(id, from, to);
  await User.collection.updateOne({ _id: id }, { $set: { accountName: to } });
}

describe('findUserByAccountName', () => {
  it('resolves a current name case-insensitively', async () => {
    const id = await mkUser('alice');
    expect(String((await findUserByAccountName('ALICE'))!._id)).toBe(String(id));
  });

  it('resolves a former name to the user, who now carries the new name', async () => {
    const id = await mkUser('a_old');
    await rename(id, 'a_old', 'b_new');
    const found = await findUserByAccountName<{ accountName: string }>('a_old');
    expect(found?.accountName).toBe('b_new');
    expect(String(found!._id)).toBe(String(id));
  });

  it('lets a current name win over a history row', async () => {
    const a = await mkUser('first');
    await rename(a, 'first', 'second');
    // Legacy data: someone else holds a name that is also in history.
    const other = await mkUser('first');
    expect(String((await findUserByAccountName('first'))!._id)).toBe(String(other));
  });

  it('returns null for an unknown name', async () => {
    expect(await findUserByAccountName('nobody')).toBeNull();
  });
});

describe('never reusing an old name', () => {
  it('blocks other users from claiming a former name, but not its previous owner', async () => {
    const id = await mkUser('a_old');
    await rename(id, 'a_old', 'b_new');
    const stranger = new mongoose.Types.ObjectId();
    expect(await isAccountNameInHistoryOfOther('a_old', stranger)).toBe(true);
    expect(await isAccountNameInHistoryOfOther('A_OLD')).toBe(true); // registration: no user yet
    expect(await isAccountNameInHistoryOfOther('a_old', id)).toBe(false);
  });

  it('releases a name when its owner switches back to it', async () => {
    const id = await mkUser('one');
    await rename(id, 'one', 'two');
    await rename(id, 'two', 'one');
    expect(await AccountNameHistory.countDocuments({ userId: id, from: 'one' })).toBe(0);
    expect(await AccountNameHistory.countDocuments({ userId: id, from: 'two' })).toBe(1);
    expect(String((await findUserByAccountName('two'))!._id)).toBe(String(id));
  });
});

/**
 * The generator behind Google sign-up and scripts/backfill-account-names.ts.
 * Every account must end up with a name, so it must never return one that is
 * invalid, reserved, already held, or a name someone previously held.
 */
describe('generateUniqueAccountName', () => {
  it('reduces a display name to the account-name charset', () => {
    expect(accountNameBase('José  Álvarez!')).toBe('jose_alvarez');
    expect(accountNameBase('***')).toBe('');
    expect(accountNameBase(null)).toBe('');
    expect(accountNameBase('x'.repeat(40))).toHaveLength(22);
  });

  it('mints a valid, unused, non-reserved name from a display name', async () => {
    const name = await generateUniqueAccountName('José Álvarez');
    expect(name).toMatch(/^jose_alvarez_\d{4}$/);
    expect(isValidAccountName(name)).toBe(true);
    expect(isReservedAccountName(name)).toBe(false);
  });

  it('falls back to a generic base when nothing usable survives', async () => {
    expect(await generateUniqueAccountName('***')).toMatch(/^user_\d{4}$/);
    expect(await generateUniqueAccountName(undefined)).toMatch(/^user_\d{4}$/);
  });

  // Pinning Math.random makes every attempt produce the SAME suffix, so these
  // two cases prove the skip actually happens instead of relying on 1-in-9000
  // luck: the generator must exhaust its attempts and fall back.
  const pinSuffix = () => vi.spyOn(Math, 'random').mockReturnValue(0.026); // -> _1234

  it('never hands out a name that is already held', async () => {
    await mkUser('solo_1234');
    const spy = pinSuffix();
    try {
      expect(await generateUniqueAccountName('solo')).not.toBe('solo_1234');
    } finally {
      spy.mockRestore();
    }
  });

  it('never hands out a name someone previously held', async () => {
    const id = await mkUser('ghost_1234');
    await rename(id, 'ghost_1234', 'ghost_new');
    const spy = pinSuffix();
    try {
      expect(await generateUniqueAccountName('ghost')).not.toBe('ghost_1234');
    } finally {
      spy.mockRestore();
    }
  });
});
