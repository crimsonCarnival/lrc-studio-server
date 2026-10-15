import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../../db/user.model.js';
import AccountNameHistory from '../../db/account-name-history.model.js';
import { findUserByAccountName, isAccountNameInHistoryOfOther, recordAccountNameChange } from './account-name.service.js';

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

const mkUser = async (accountName: string) =>
  (await User.collection.insertOne({ accountName, email: `${accountName}@x.test`, passwordHash: 'x' })).insertedId;

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
