import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import Block from '../blocks/block.model.js';
import { invalidateBlockCache } from '../blocks/block-list.cache.js';
import Notification from '../notifications/notification.model.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { updatePreferences } from '../user-preferences/user-preferences.service.js';
import { WallComment, WallSubscription } from './wall.models.js';
import { addComment, deleteComment, getWall, setSubscription, WallError } from './wall.service.js';

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
    User.deleteMany({}), Block.deleteMany({}), Notification.deleteMany({}),
    UserPreferences.deleteMany({}), WallComment.deleteMany({}), WallSubscription.deleteMany({}),
  ]);
});

async function mkUser(accountName: string, permissions: string[] = []): Promise<string> {
  const res = await User.collection.insertOne({
    accountName, email: `${accountName}@x.test`, passwordHash: 'x', isDeleted: false, role: 'user', permissions, ban: { active: false },
  });
  return res.insertedId.toString();
}

const codeOf = async (run: () => Promise<unknown>) => {
  try { await run(); } catch (err) { return err instanceof WallError ? err.code : 'other'; }
  return 'none';
};

describe('wall comments and replies', () => {
  it('nests replies two levels deep and refuses a third', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    const top = await addComment(a, 'sam', 'first');
    const reply = await addComment(b, 'sam', 'second', top.id);
    const nested = await addComment(a, 'sam', 'third', reply.id);
    expect(await codeOf(() => addComment(b, 'sam', 'fourth', nested.id))).toBe('max_depth');

    const wall = await getWall(owner, 'sam');
    expect(wall.total).toBe(1);
    expect(wall.comments[0].replies[0].replies[0]).toMatchObject({ body: 'third', depth: 2 });
  });

  it('subscribes the author when they comment, and tells the owner and earlier commenters once', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    await addComment(a, 'sam', 'hi');
    expect(await WallSubscription.countDocuments({ userId: a })).toBe(1);

    await addComment(b, 'sam', 'me too');
    await new Promise(r => setTimeout(r, 50));
    // The owner heard about both comments in one notification; ann heard about bob's.
    const ownerNotes = await Notification.find({ userId: owner, type: 'wall_comment' }).lean();
    expect(ownerNotes).toHaveLength(1);
    expect(ownerNotes[0].actorCount).toBe(2);
    expect(await Notification.countDocuments({ userId: a, type: 'wall_comment' })).toBe(1);
    expect(await Notification.countDocuments({ userId: b, type: 'wall_comment' })).toBe(0);
  });

  it('tells the author of the comment being answered that it is a reply', async () => {
    await mkUser('sam');
    const a = await mkUser('ann'), b = await mkUser('bob');
    const top = await addComment(a, 'sam', 'question');
    await addComment(b, 'sam', 'answer', top.id);
    await new Promise(r => setTimeout(r, 50));
    const note = await Notification.findOne({ userId: a, type: 'wall_comment' }).lean();
    expect(note?.meta).toMatchObject({ reply: true });
  });

  it('lets the author, the wall owner and a moderator delete, and takes the replies along', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob'), mod = await mkUser('mia', ['users.ban']);
    const top = await addComment(a, 'sam', 'first');
    await addComment(b, 'sam', 'reply', top.id);

    expect(await codeOf(() => deleteComment(b, top.id))).toBe('forbidden');
    await deleteComment(mod, top.id);
    expect(await WallComment.countDocuments({})).toBe(0);

    const again = await addComment(a, 'sam', 'again');
    await deleteComment(owner, again.id);
    expect(await WallComment.countDocuments({})).toBe(0);
  });

  it('hides comments by someone the viewer is blocked with', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), viewer = await mkUser('vic');
    await addComment(a, 'sam', 'visible to most');
    await Block.collection.insertOne({ blockerId: new mongoose.Types.ObjectId(viewer), blockedId: new mongoose.Types.ObjectId(a), createdAt: new Date() });
    invalidateBlockCache(viewer);
    expect((await getWall(viewer, 'sam')).comments).toHaveLength(0);
    expect((await getWall(owner, 'sam')).comments).toHaveLength(1);
  });

  it('refuses comments on a wall the owner turned off, and on bad input', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    expect(await codeOf(() => addComment(a, 'sam', '   '))).toBe('invalid_body');
    expect(await codeOf(() => addComment(a, 'sam', 'x'.repeat(501)))).toBe('invalid_body');

    await updatePreferences(owner, { wallEnabled: false });
    expect(await codeOf(() => addComment(a, 'sam', 'hello'))).toBe('wall_disabled');
    expect((await getWall(a, 'sam')).enabled).toBe(false);
  });

  it('strips markup from a comment', async () => {
    await mkUser('sam');
    const a = await mkUser('ann');
    const saved = await addComment(a, 'sam', 'hi <script>alert(1)</script><b>there</b>');
    expect(saved.body).not.toContain('<');
  });

  it('lets a visitor unsubscribe, and the owner not subscribe to their own wall', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await addComment(a, 'sam', 'hi');
    expect(await setSubscription(a, 'sam', false)).toBe(false);
    expect(await WallSubscription.countDocuments({})).toBe(0);
    expect(await setSubscription(owner, 'sam', true)).toBe(false);
  });
});
