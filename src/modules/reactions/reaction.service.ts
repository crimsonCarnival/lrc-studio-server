import mongoose from 'mongoose';
import Reaction, { ALLOWED_EMOJIS } from '../../db/reaction.model.js';
import Comment from '../../db/comment.model.js';
import User from '../../db/user.model.js';
import { getIO } from '../../socket/socket.manager.js';

interface ReactionSummary {
  emoji: string;
  count: number;
}

interface HydratedUser {
  id: string;
  accountName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface SerializedComment {
  id: string;
  projectId: string;
  user: HydratedUser;
  text: string;
  parentId: string | null;
  replyCount: number;
  reactions: ReactionSummary[];
  myReaction: string | null;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

async function getReactionSummary(
  targetType: string,
  targetId: string
): Promise<ReactionSummary[]> {
  const rows = await Reaction.aggregate([
    { $match: { targetType, targetId } },
    { $group: { _id: '$emoji', count: { $sum: 1 } } },
  ]);
  return rows.map(r => ({ emoji: r._id as string, count: r.count as number }));
}

async function hydrateUser(userId: mongoose.Types.ObjectId | string): Promise<HydratedUser> {
  const user = await User.findById(userId).lean();
  if (!user) {
    return {
      id: userId.toString(),
      accountName: '[deleted]',
      displayName: null,
      avatarUrl: null,
    };
  }
  return {
    id: user._id.toString(),
    accountName: user.accountName ?? null,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

async function runToggle(
  userId: string,
  targetType: 'comment' | 'project',
  targetId: string,
  emoji: string
): Promise<boolean> {
  const existing = await Reaction.findOne({ userId, targetType, targetId });

  if (existing) {
    if (existing.emoji === emoji) {
      await existing.deleteOne();
      return false;
    }
    existing.emoji = emoji as typeof ALLOWED_EMOJIS[number];
    await existing.save();
    return true;
  }

  await Reaction.create({
    userId: new mongoose.Types.ObjectId(userId),
    targetType,
    targetId,
    emoji,
  });
  return true;
}

export async function reactToComment(
  commentId: string,
  userId: string,
  emoji: string
): Promise<{ reactions: ReactionSummary[]; myReaction: string | null }> {
  if (!(ALLOWED_EMOJIS as readonly string[]).includes(emoji)) throw new Error('Invalid emoji');

  const kept = await runToggle(userId, 'comment', commentId, emoji);

  const reactions = await getReactionSummary('comment', commentId);
  const myReaction = kept ? emoji : null;

  const comment = await Comment.findById(commentId).lean();
  if (comment) {
    try {
      getIO()
        .to(`project:${comment.projectId}`)
        .emit('reaction:update', { targetType: 'comment', targetId: commentId, reactions });
    } catch {}
  }

  return { reactions, myReaction };
}

export async function reactToCommentFull(
  commentId: string,
  userId: string,
  emoji: string
): Promise<SerializedComment> {
  const { reactions, myReaction } = await reactToComment(commentId, userId, emoji);

  const doc = await Comment.findById(commentId);
  if (!doc) throw new Error('Comment not found');

  const user = await hydrateUser(doc.userId);

  return {
    id: doc._id.toString(),
    projectId: doc.projectId,
    user,
    text: doc.isDeleted ? '' : doc.text,
    parentId: doc.parentId?.toString() ?? null,
    replyCount: doc.replyCount,
    reactions,
    myReaction,
    isDeleted: doc.isDeleted,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function reactToProject(
  projectId: string,
  userId: string,
  emoji: string
): Promise<{ reactions: ReactionSummary[]; myReaction: string | null }> {
  if (!(ALLOWED_EMOJIS as readonly string[]).includes(emoji)) throw new Error('Invalid emoji');

  const kept = await runToggle(userId, 'project', projectId, emoji);

  const reactions = await getReactionSummary('project', projectId);
  const myReaction = kept ? emoji : null;

  try {
    getIO()
      .to(`project:${projectId}`)
      .emit('reaction:update', { targetType: 'project', targetId: projectId, reactions });
  } catch {}

  return { reactions, myReaction };
}

export async function getProjectReactions(
  projectId: string,
  viewerUserId?: string
): Promise<{ reactions: ReactionSummary[]; myReaction: string | null }> {
  const reactions = await getReactionSummary('project', projectId);

  let myReaction: string | null = null;
  if (viewerUserId) {
    const r = await Reaction.findOne({
      userId: new mongoose.Types.ObjectId(viewerUserId),
      targetType: 'project',
      targetId: projectId,
    }).lean();
    myReaction = r?.emoji ?? null;
  }

  return { reactions, myReaction };
}
