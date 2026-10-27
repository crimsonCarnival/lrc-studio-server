import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import Block from '../blocks/block.model.js';
import { invalidateBlockCache } from '../blocks/block-list.cache.js';
import Notification from '../notifications/notification.model.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { updatePreferences } from '../user-preferences/user-preferences.service.js';
import { WallComment, WallCommentLike, WallSubscription } from './wall.models.js';
import Project from '../projects/project.model.js';
import { addComment, deleteComment, getWall, setLike, setSubscription, WallError } from './wall.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Folding concurrent notifications relies on its unique index existing.
  await Notification.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Block.deleteMany({}), Notification.deleteMany({}),
    UserPreferences.deleteMany({}), WallComment.deleteMany({}), WallSubscription.deleteMany({}),
    Project.deleteMany({}), WallCommentLike.deleteMany({}),
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
  it('nests replies two levels deep, and puts a reply to the deepest level beside it', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    const top = await addComment(a, 'sam', 'first');
    const reply = await addComment(b, 'sam', 'second', top.id);
    const nested = await addComment(a, 'sam', 'third', reply.id);
    const later = await addComment(b, 'sam', 'later', reply.id);
    const answer = await addComment(b, 'sam', 'fourth', nested.id);
    expect(answer).toMatchObject({ depth: 2, replyToId: nested.id });

    const wall = await getWall(owner, 'sam');
    expect(wall.total).toBe(1);
    // The answer sits right below the comment it answers, ahead of the older 'later'.
    expect(wall.comments[0].replies[0].replies.map(r => r.id)).toEqual([nested.id, answer.id, later.id]);
  });

  it('links the notification to the newest comment', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await addComment(a, 'sam', 'first');
    const second = await addComment(a, 'sam', 'second');
    await new Promise(r => setTimeout(r, 50));
    expect(await Notification.findOne({ userId: owner, type: 'wall_comment' }).lean()).toMatchObject({ meta: { commentId: second.id } });
  });

  it('tells the author of the deepest-level comment that it was answered', async () => {
    await mkUser('sam');
    const a = await mkUser('ann'), b = await mkUser('bob');
    const top = await addComment(a, 'sam', 'first');
    const reply = await addComment(b, 'sam', 'second', top.id);
    const nested = await addComment(a, 'sam', 'third', reply.id);
    await Notification.deleteMany({});
    await addComment(b, 'sam', 'fourth', nested.id);
    await new Promise(r => setTimeout(r, 50));
    expect(await Notification.findOne({ userId: a, type: 'wall_comment' }).lean()).toMatchObject({ meta: { reply: true } });
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

describe('likes', () => {
  it('counts likes once per person and shows the viewer theirs', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    const c = await addComment(a, 'sam', 'hi');
    expect(await setLike(b, c.id, true)).toEqual({ liked: true, likeCount: 1 });
    expect(await setLike(b, c.id, true)).toEqual({ liked: true, likeCount: 1 });
    await setLike(owner, c.id, true);

    expect((await getWall(b, 'sam')).comments[0]).toMatchObject({ likeCount: 2, likedByMe: true });
    expect((await getWall(a, 'sam')).comments[0]).toMatchObject({ likeCount: 2, likedByMe: false });
    expect(await setLike(b, c.id, false)).toEqual({ liked: false, likeCount: 1 });
  });

  it('refuses a like from someone blocked with the author, and drops likes with the comment', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    const c = await addComment(a, 'sam', 'hi');
    await setLike(owner, c.id, true);
    await Block.create({ blockerId: a, blockedId: b });
    invalidateBlockCache(a); invalidateBlockCache(b);
    expect(await codeOf(() => setLike(b, c.id, true))).toBe('forbidden');

    await deleteComment(a, c.id);
    expect(await WallCommentLike.countDocuments({})).toBe(0);
  });
});

describe('tags', () => {
  const settle = () => new Promise(r => setTimeout(r, 50));
  async function mkProject(ownerId: string, publicId: string, isPublic: boolean) {
    await Project.collection.insertOne({ publicId, slug: publicId, title: `Song ${publicId}`, userId: new mongoose.Types.ObjectId(ownerId), public: isPublic, coverImage: '' });
  }

  it('resolves tagged people and projects', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await mkProject(owner, 'pub1', true);
    const saved = await addComment(a, 'sam', `hey @[u:${owner}] look @[p:pub1]`);
    expect(saved.mentions).toEqual([{ id: owner, accountName: 'sam', displayName: null }]);
    expect(saved.projectRefs).toMatchObject([{ publicId: 'pub1', title: 'Song pub1', ownerAccountName: 'sam' }]);
  });

  it('refuses a tag that does not resolve for the author', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await mkProject(owner, 'secret', false);
    expect(await codeOf(() => addComment(a, 'sam', '@[p:secret]'))).toBe('invalid_body');
    expect(await codeOf(() => addComment(a, 'sam', `@[u:${new mongoose.Types.ObjectId()}]`))).toBe('invalid_body');
  });

  it('lets owners tag their own private project, and hides it from everyone else', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await mkProject(owner, 'mine', false);
    await addComment(owner, 'sam', 'wip @[p:mine]');
    expect((await getWall(owner, 'sam')).comments[0].projectRefs).toHaveLength(1);
    expect((await getWall(a, 'sam')).comments[0].projectRefs).toHaveLength(0);
    expect((await getWall(null, 'sam')).comments[0].projectRefs).toHaveLength(0);
  });

  it('tells a tagged person with a mention instead of a plain comment notification', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann'), b = await mkUser('bob');
    await addComment(b, 'sam', 'first'); // bob is now subscribed
    await addComment(a, 'sam', `@[u:${b}] and @[u:${owner}] see this`);
    await settle();
    expect(await Notification.countDocuments({ userId: b, type: 'mention' })).toBe(1);
    expect(await Notification.countDocuments({ userId: b, type: 'wall_comment' })).toBe(0);
    expect(await Notification.countDocuments({ userId: owner, type: 'mention' })).toBe(1);
  });

  it('falls back to the plain notification when the tagged person turned mentions off', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await updatePreferences(owner, { notifications: { mention: false } } as never);
    await addComment(a, 'sam', `@[u:${owner}] hi`);
    await settle();
    expect(await Notification.countDocuments({ userId: owner, type: 'mention' })).toBe(0);
    expect(await Notification.countDocuments({ userId: owner, type: 'wall_comment' })).toBe(1);
  });

  it('refuses to tag someone who switched tags off, but still lets them tag others and themselves', async () => {
    const owner = await mkUser('sam'), a = await mkUser('ann');
    await updatePreferences(owner, { allowTags: false });
    expect(await codeOf(() => addComment(a, 'sam', `@[u:${owner}] hi`))).toBe('tag_not_allowed');
    expect(await codeOf(() => addComment(owner, 'sam', `@[u:${a}] and @[u:${owner}]`))).toBe('none');
    // The wall says so, so a reply to them doesn't start by tagging them.
    expect((await getWall(a, 'sam')).comments[0].author.allowsTags).toBe(false);
  });

  it('does not notify you for tagging yourself', async () => {
    const a = await mkUser('ann');
    await mkUser('sam');
    await addComment(a, 'sam', `@[u:${a}] note to self`);
    await settle();
    expect(await Notification.countDocuments({ userId: a })).toBe(0);
  });
});
