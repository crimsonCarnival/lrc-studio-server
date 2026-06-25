import mongoose from 'mongoose';
import Block from '../../db/block.model.js';
import Follow from '../../db/follow.model.js';
import User, { type IUser } from '../../db/user.model.js';
import { getCachedBlockedSet, invalidateBlockCache } from './block-list.cache.js';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

// Remove a single follow edge and decrement the cached counts (mirrors unfollow).
async function removeFollowEdge(
  followerId: mongoose.Types.ObjectId,
  followingId: mongoose.Types.ObjectId,
): Promise<void> {
  const res = await Follow.deleteOne({ followerId, followingId });
  if (res.deletedCount > 0) {
    await Promise.all([
      User.updateOne(
        { _id: followingId, 'social.followerCount': { $gt: 0 } },
        { $inc: { 'social.followerCount': -1 } },
      ),
      User.updateOne(
        { _id: followerId, 'social.followingCount': { $gt: 0 } },
        { $inc: { 'social.followingCount': -1 } },
      ),
    ]);
  }
}

export async function blockUser(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) throw new Error('Cannot block yourself');
  const blocker = oid(blockerId);
  const blocked = oid(blockedId);

  // Idempotent: a repeat block is a no-op.
  await Block.updateOne(
    { blockerId: blocker, blockedId: blocked },
    { $setOnInsert: { blockerId: blocker, blockedId: blocked } },
    { upsert: true },
  );

  invalidateBlockCache(blockerId);
  invalidateBlockCache(blockedId);

  // Sever the relationship in both directions.
  await Promise.all([
    removeFollowEdge(blocker, blocked),
    removeFollowEdge(blocked, blocker),
  ]);
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await Block.deleteOne({ blockerId: oid(blockerId), blockedId: oid(blockedId) });
  invalidateBlockCache(blockerId);
  invalidateBlockCache(blockedId);
}

export interface BlockedUserView {
  id: string;
  accountName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  blockedAt: string | null;
}

// Users the viewer has blocked, newest first — for the settings list.
export async function listBlocked(blockerId: string): Promise<BlockedUserView[]> {
  const blocks = await Block.find({ blockerId: oid(blockerId) })
    .sort({ createdAt: -1 })
    .select('blockedId createdAt')
    .lean();
  const ids = blocks.map((b) => b.blockedId);
  if (ids.length === 0) return [];

  const users = await User.find({ _id: { $in: ids } })
    .select('accountName displayName avatarUrl')
    .lean<IUser[]>();
  const map = new Map(users.map((u) => [u._id.toString(), u]));

  return blocks.flatMap((b) => {
    const u = map.get(b.blockedId.toString());
    if (!u) return [];
    return [{
      id: u._id.toString(),
      accountName: u.accountName ?? null,
      displayName: u.displayName ?? null,
      avatarUrl: u.avatarUrl ?? null,
      blockedAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
    }];
  });
}

// All user ids in a block relationship with the viewer (either direction).
// Used to filter discovery surfaces symmetrically (suggestions, search, feed).
// Delegates to the LRU cache; falls through to DB on miss.
export async function getBlockedSet(viewerId?: string | null): Promise<Set<string>> {
  if (!viewerId) return new Set();
  return getCachedBlockedSet(viewerId);
}

// Directional check: did `blockerId` block `blockedId`?
export async function hasBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  return !!(await Block.exists({ blockerId: oid(blockerId), blockedId: oid(blockedId) }));
}

// Either-direction check between two users.
export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  return !!(await Block.exists({
    $or: [
      { blockerId: oid(a), blockedId: oid(b) },
      { blockerId: oid(b), blockedId: oid(a) },
    ],
  }));
}
