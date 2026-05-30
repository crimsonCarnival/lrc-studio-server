import mongoose from 'mongoose';
import Comment from '../../db/comment.model.js';
import Reaction from '../../db/reaction.model.js';
import User from '../../db/user.model.js';
import { getIO } from '../../socket/socket.manager.js';

interface HydratedUser {
  id: string;
  accountName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface ReactionSummary {
  emoji: string;
  count: number;
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

async function aggregateReactions(
  targetType: string,
  targetIds: string[]
): Promise<Map<string, ReactionSummary[]>> {
  const results = await Reaction.aggregate([
    { $match: { targetType, targetId: { $in: targetIds } } },
    { $group: { _id: { targetId: '$targetId', emoji: '$emoji' }, count: { $sum: 1 } } },
  ]);

  const map = new Map<string, ReactionSummary[]>();
  for (const item of results) {
    const { targetId, emoji } = item._id as { targetId: string; emoji: string };
    if (!map.has(targetId)) map.set(targetId, []);
    map.get(targetId)!.push({ emoji, count: item.count as number });
  }
  return map;
}

function serializeComment(
  doc: mongoose.Document & {
    _id: mongoose.Types.ObjectId;
    projectId: string;
    userId: mongoose.Types.ObjectId;
    text: string;
    parentId?: mongoose.Types.ObjectId | null;
    replyCount: number;
    isDeleted: boolean;
    createdAt: Date;
    updatedAt: Date;
  },
  user: HydratedUser,
  reactions: ReactionSummary[],
  myReaction: string | null
): SerializedComment {
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

export async function getComments(
  projectId: string,
  offset: number,
  limit: number,
  viewerUserId?: string
): Promise<{ comments: SerializedComment[]; total: number; hasMore: boolean }> {
  const query = { projectId, parentId: null };

  const [docs, total] = await Promise.all([
    Comment.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit),
    Comment.countDocuments(query),
  ]);

  const ids = docs.map(d => d._id.toString());
  const reactionsMap = await aggregateReactions('comment', ids);

  let myReactionsMap = new Map<string, string>();
  if (viewerUserId && ids.length > 0) {
    const myReactions = await Reaction.find({
      userId: new mongoose.Types.ObjectId(viewerUserId),
      targetType: 'comment',
      targetId: { $in: ids },
    }).lean();
    for (const r of myReactions) {
      myReactionsMap.set(r.targetId, r.emoji);
    }
  }

  const comments = await Promise.all(
    docs.map(async doc => {
      const user = await hydrateUser(doc.userId);
      const id = doc._id.toString();
      return serializeComment(doc, user, reactionsMap.get(id) ?? [], myReactionsMap.get(id) ?? null);
    })
  );

  return { comments, total, hasMore: offset + docs.length < total };
}

export async function getCommentReplies(
  commentId: string,
  offset: number,
  limit: number,
  viewerUserId?: string
): Promise<SerializedComment[]> {
  const docs = await Comment.find({ parentId: new mongoose.Types.ObjectId(commentId) })
    .sort({ createdAt: 1 })
    .skip(offset)
    .limit(limit);

  const ids = docs.map(d => d._id.toString());
  const reactionsMap = await aggregateReactions('comment', ids);

  let myReactionsMap = new Map<string, string>();
  if (viewerUserId && ids.length > 0) {
    const myReactions = await Reaction.find({
      userId: new mongoose.Types.ObjectId(viewerUserId),
      targetType: 'comment',
      targetId: { $in: ids },
    }).lean();
    for (const r of myReactions) {
      myReactionsMap.set(r.targetId, r.emoji);
    }
  }

  return Promise.all(
    docs.map(async doc => {
      const user = await hydrateUser(doc.userId);
      const id = doc._id.toString();
      return serializeComment(doc, user, reactionsMap.get(id) ?? [], myReactionsMap.get(id) ?? null);
    })
  );
}

export async function addComment(
  projectId: string,
  userId: string,
  text: string,
  parentId?: string
): Promise<SerializedComment> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 1000) throw new Error('Invalid comment text');

  const doc = await Comment.create({
    projectId,
    userId: new mongoose.Types.ObjectId(userId),
    text: trimmed,
    parentId: parentId ? new mongoose.Types.ObjectId(parentId) : null,
  });

  if (parentId) {
    await Comment.findByIdAndUpdate(parentId, { $inc: { replyCount: 1 } });
  }

  const user = await hydrateUser(doc.userId);
  const serialized = serializeComment(doc, user, [], null);

  try {
    getIO().to(`project:${projectId}`).emit('comment:new', serialized);
  } catch {}

  return serialized;
}

export async function deleteComment(id: string, userId: string): Promise<true> {
  const doc = await Comment.findById(id);
  if (!doc) throw new Error('Comment not found');
  if (doc.userId.toString() !== userId) throw new Error('Forbidden');

  doc.isDeleted = true;
  doc.text = '';
  await doc.save();

  try {
    getIO().to(`project:${doc.projectId}`).emit('comment:deleted', { commentId: id });
  } catch {}

  return true;
}
