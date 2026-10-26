import mongoose from 'mongoose';
import User from '../users/user.model.js';
import type { IUser } from '../users/user.model.js';
import { WallComment, WallCommentLike, WallSubscription, WALL_MAX_DEPTH, WALL_MAX_LENGTH } from './wall.models.js';
import type { IWallComment } from './wall.models.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { getBlockedSet, isBlockedEitherWay } from '../blocks/block.service.js';
import { hasPermission } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import { notifyWallComment, notifyMention } from '../notifications/notifications.events.js';
import { parseTags, checkTags, resolveTags, tagsOf } from './wall-mentions.js';
import type { WallMention, WallProjectRef } from './wall-mentions.js';

const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// Per author, across every wall.
const RATE_LIMIT_COUNT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
// A wall with more subscribers than this tells the first ones; it is a fan-out cap.
const MAX_SUBSCRIBER_FANOUT = 500;

/** The error codes the resolvers pass on; the client maps each to a message. */
export class WallError extends Error {
  constructor(public code: 'not_found' | 'wall_disabled' | 'forbidden' | 'invalid_body' | 'rate_limited' | 'max_depth' | 'tag_not_allowed') {
    super(code);
  }
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

type LeanUser = IUser & { _id: mongoose.Types.ObjectId };
type LeanComment = IWallComment & { _id: mongoose.Types.ObjectId };

export interface WallAuthor {
  id: string;
  accountName: string;
  displayName: string | null;
  avatarUrl: string | null;
  staffRole: string | null;
  /** Whether others may tag this author (the client pre-tags a reply only when they may). */
  allowsTags: boolean;
}

export interface WallCommentView {
  id: string;
  body: string;
  mentions: WallMention[];
  projectRefs: WallProjectRef[];
  createdAt: string;
  depth: number;
  author: WallAuthor;
  canDelete: boolean;
  likeCount: number;
  likedByMe: boolean;
  /** The sibling this reply answers, for a reply at the deepest level; otherwise null. */
  replyToId: string | null;
  replies: WallCommentView[];
}

/**
 * Siblings oldest first, except that a reply to a sibling comes right after that sibling
 * (and after the earlier replies to it), so a conversation at the deepest level reads in order.
 */
export function orderSiblings<T extends { id: string; replyToId: string | null }>(siblings: T[]): T[] {
  const ids = new Set(siblings.map((s) => s.id));
  const answers = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of siblings) {
    if (s.replyToId && ids.has(s.replyToId)) answers.set(s.replyToId, [...(answers.get(s.replyToId) ?? []), s]);
    else roots.push(s);
  }
  const out: T[] = [];
  const visit = (s: T) => { out.push(s); for (const a of answers.get(s.id) ?? []) visit(a); };
  roots.forEach(visit);
  return out;
}

export interface WallView {
  enabled: boolean;
  comments: WallCommentView[];
  hasMore: boolean;
  total: number;
  subscribed: boolean;
}

async function findOwner(accountName: string): Promise<LeanUser> {
  const owner = await User.findOne({ accountName: accountName.toLowerCase() }).lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active) throw new WallError('not_found');
  return owner;
}

const authorView = (u: LeanUser, allowsTags: boolean): WallAuthor => ({
  id: u._id.toString(),
  accountName: u.accountName ?? '',
  displayName: u.displayName ?? null,
  avatarUrl: u.avatarUrl ?? null,
  staffRole: u.role && u.role !== 'user' ? u.role : null,
  allowsTags,
});

/**
 * One page of a wall: top-level comments newest first, each with its whole reply tree
 * (oldest reply first). Comments by anyone the viewer is blocked with are left out, and
 * with them everything beneath.
 */
export async function getWall(
  viewerId: string | null,
  accountName: string,
  { after, limit }: { after?: string | null; limit?: number | null } = {},
): Promise<WallView> {
  const owner = await findOwner(accountName);
  const ownerId = owner._id.toString();
  if (viewerId && viewerId !== ownerId && await isBlockedEitherWay(viewerId, ownerId)) throw new WallError('not_found');

  const prefs = await getPreferences(ownerId);
  if (prefs.wallEnabled === false) {
    return { enabled: false, comments: [], hasMore: false, total: 0, subscribed: false };
  }

  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, limit ?? PAGE_SIZE));
  const cursor = after && !Number.isNaN(Date.parse(after)) ? { createdAt: { $lt: new Date(after) } } : {};
  const topFilter = { wallUserId: owner._id, parentId: null };

  const [topPlusOne, total] = await Promise.all([
    WallComment.find({ ...topFilter, ...cursor }).sort({ createdAt: -1 }).limit(size + 1).lean<LeanComment[]>(),
    WallComment.countDocuments(topFilter),
  ]);
  const hasMore = topPlusOne.length > size;
  const top = topPlusOne.slice(0, size);

  // The replies, one level at a time (the depth is capped, so this is at most two queries).
  const levels: LeanComment[][] = [top];
  for (let depth = 1; depth <= WALL_MAX_DEPTH; depth++) {
    const parents = levels[depth - 1];
    levels.push(parents.length === 0 ? [] : await WallComment.find({ parentId: { $in: parents.map(c => c._id) } }).sort({ createdAt: 1 }).lean<LeanComment[]>());
  }
  const all = levels.flat();

  const authorIds = [...new Set(all.map(c => c.authorId.toString()))];
  const authors = authorIds.length
    ? await User.find({ _id: { $in: authorIds.map(oid) } }).select('accountName displayName avatarUrl role').lean<LeanUser[]>()
    : [];
  const authorById = new Map(authors.map(a => [a._id.toString(), a]));
  const untaggable = new Set(
    (authorIds.length
      ? await UserPreferences.find({ userId: { $in: authorIds.map(oid) }, allowTags: false }).select('userId').lean()
      : []
    ).map(p => p.userId.toString()),
  );

  const viewer = viewerId ? await User.findById(viewerId).select('permissions').lean<LeanUser>() : null;
  const viewerIsOwner = viewerId === ownerId;
  const viewerIsStaff = !!viewer && hasPermission(viewer.permissions, 'users.ban');
  const blockedSet = await getBlockedSet(viewerId);
  const resolved = await resolveTags(all.map(c => c.body), viewerId);

  // Like counts for the whole page in one aggregation, and which of them are the viewer's.
  const commentIds = all.map(c => c._id);
  const [likeCounts, myLikes] = await Promise.all([
    commentIds.length
      ? WallCommentLike.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
          { $match: { commentId: { $in: commentIds } } },
          { $group: { _id: '$commentId', n: { $sum: 1 } } },
        ])
      : [],
    viewerId && commentIds.length
      ? WallCommentLike.find({ commentId: { $in: commentIds }, userId: oid(viewerId) }).select('commentId').lean()
      : [],
  ]);
  const likeCountOf = new Map(likeCounts.map(l => [l._id.toString(), l.n]));
  const likedByViewer = new Set(myLikes.map(l => l.commentId.toString()));

  const build = (c: LeanComment, byParent: Map<string, LeanComment[]>): WallCommentView | null => {
    const author = authorById.get(c.authorId.toString());
    if (!author || author.isDeleted || blockedSet.has(c.authorId.toString())) return null;
    return {
      id: c._id.toString(),
      body: c.body,
      ...tagsOf(c.body, resolved),
      createdAt: c.createdAt.toISOString(),
      depth: c.depth,
      author: authorView(author, !untaggable.has(c.authorId.toString())),
      canDelete: viewerId === c.authorId.toString() || viewerIsOwner || viewerIsStaff,
      likeCount: likeCountOf.get(c._id.toString()) ?? 0,
      likedByMe: likedByViewer.has(c._id.toString()),
      replyToId: c.replyToId?.toString() ?? null,
      replies: orderSiblings((byParent.get(c._id.toString()) ?? []).map(r => build(r, byParent)).filter((r): r is WallCommentView => r !== null)),
    };
  };
  const byParent = new Map<string, LeanComment[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const key = c.parentId.toString();
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }

  const subscribed = viewerId && !viewerIsOwner
    ? !!(await WallSubscription.exists({ wallUserId: owner._id, userId: oid(viewerId) }))
    : false;

  return {
    enabled: true,
    comments: top.map(c => build(c, byParent)).filter((c): c is WallCommentView => c !== null),
    hasMore,
    total,
    subscribed,
  };
}

/**
 * Adds a comment, or a reply when `parentId` is given. Commenting subscribes the author to
 * the wall. The owner, the other subscribers, and the author of the comment being replied to
 * are each told once.
 */
export async function addComment(
  authorId: string,
  accountName: string,
  rawBody: string,
  parentId?: string | null,
): Promise<WallCommentView> {
  const owner = await findOwner(accountName);
  const ownerId = owner._id.toString();
  if (authorId !== ownerId && await isBlockedEitherWay(authorId, ownerId)) throw new WallError('forbidden');
  if ((await getPreferences(ownerId)).wallEnabled === false) throw new WallError('wall_disabled');

  const body = stripHtml(rawBody ?? '').trim();
  if (body.length < 1 || body.length > WALL_MAX_LENGTH) throw new WallError('invalid_body');
  // A forged, stale or out-of-reach tag (someone else's private project) rejects the comment,
  // and so does tagging someone who switched tags off.
  const tags = parseTags(body);
  const tagCheck = await checkTags(authorId, tags);
  if (tagCheck === 'invalid') throw new WallError('invalid_body');
  if (tagCheck === 'not_allowed') throw new WallError('tag_not_allowed');

  const recent = await WallComment.countDocuments({ authorId: oid(authorId), createdAt: { $gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) } });
  if (recent >= RATE_LIMIT_COUNT) throw new WallError('rate_limited');

  let parent: LeanComment | null = null;
  // The comment being answered. Usually the parent; for a reply to a comment already at the
  // deepest level, the new reply sits beside it (same parent, same depth) instead of under it.
  let answered: LeanComment | null = null;
  let depth = 0;
  if (parentId) {
    if (!mongoose.isValidObjectId(parentId)) throw new WallError('not_found');
    answered = await WallComment.findOne({ _id: parentId, wallUserId: owner._id }).lean<LeanComment>();
    if (!answered) throw new WallError('not_found');
    parent = answered;
    if (answered.depth >= WALL_MAX_DEPTH) {
      parent = answered.parentId ? await WallComment.findById(answered.parentId).lean<LeanComment>() : null;
      if (!parent) throw new WallError('not_found');
    }
    depth = parent.depth + 1;
    // Replying to someone who blocked you, or whom you blocked, is not allowed either.
    if (answered.authorId.toString() !== authorId && await isBlockedEitherWay(authorId, answered.authorId.toString())) throw new WallError('forbidden');
  }

  const created = await WallComment.create({
    wallUserId: owner._id,
    authorId: oid(authorId),
    parentId: parent?._id ?? null,
    replyToId: answered && answered._id.toString() !== parent?._id.toString() ? answered._id : null,
    depth,
    body,
  });

  const author = await User.findById(authorId).select('accountName displayName avatarUrl role').lean<LeanUser>();
  if (!author) throw new WallError('not_found');

  // Commenting turns notifications for this wall on. The owner needs no subscription.
  if (authorId !== ownerId) {
    await WallSubscription.updateOne(
      { wallUserId: owner._id, userId: oid(authorId) },
      { $setOnInsert: { wallUserId: owner._id, userId: oid(authorId) } },
      { upsert: true },
    );
  }

  // Who hears about this comment is decided now, not when the background send runs:
  // otherwise someone who subscribes a moment later is told about a comment that predates them.
  const subscriberIds = (await WallSubscription.find({ wallUserId: owner._id })
    .limit(MAX_SUBSCRIBER_FANOUT)
    .select('userId')
    .lean<{ userId: mongoose.Types.ObjectId }[]>()).map((s) => s.userId.toString());

  announce({ owner, author, authorId, answered, subscriberIds, mentionedIds: tags.userIds }).catch(() => {});

  return {
    id: created._id.toString(),
    body,
    ...tagsOf(body, await resolveTags([body], authorId)),
    createdAt: created.createdAt.toISOString(),
    depth,
    author: authorView(author, (await getPreferences(authorId)).allowTags !== false),
    canDelete: true,
    likeCount: 0,
    likedByMe: false,
    replyToId: created.replyToId?.toString() ?? null,
    replies: [],
  };
}

async function announce({ owner, author, authorId, answered, subscriberIds, mentionedIds }: {
  owner: LeanUser;
  author: LeanUser;
  authorId: string;
  answered: LeanComment | null;
  subscriberIds: string[];
  mentionedIds: string[];
}): Promise<void> {
  const ownerId = owner._id.toString();
  const actor = { userId: authorId, accountName: author.accountName ?? '', avatarUrl: author.avatarUrl ?? null };
  const wall = owner.accountName ?? '';
  const told = new Set<string>([authorId]);

  // Being tagged is the most specific news, so a tagged person hears that instead of a
  // plain "new comment". Someone in a block relationship with the wall's owner cannot
  // open the wall, so they are not told about a tag on it.
  // Only a delivered mention replaces the plain notification: with mentions switched off,
  // a subscriber still hears about the comment the usual way.
  for (const id of mentionedIds) {
    if (told.has(id)) continue;
    if (id !== ownerId && await isBlockedEitherWay(id, ownerId)) { told.add(id); continue; }
    if (await notifyMention({ recipientId: id, actor, wallOwnerAccountName: wall }).catch(() => false)) told.add(id);
  }

  // Whoever wrote the comment being answered hears it as a reply.
  if (answered && !told.has(answered.authorId.toString())) {
    told.add(answered.authorId.toString());
    await notifyWallComment({ recipientId: answered.authorId.toString(), actor, wallOwnerAccountName: wall, reply: true }).catch(() => {});
  }
  // The wall's owner, then everyone subscribed to it.
  if (!told.has(ownerId)) {
    told.add(ownerId);
    await notifyWallComment({ recipientId: ownerId, actor, wallOwnerAccountName: wall, reply: false }).catch(() => {});
  }
  await Promise.all(subscriberIds.map(async (id) => {
    if (told.has(id)) return;
    told.add(id);
    await notifyWallComment({ recipientId: id, actor, wallOwnerAccountName: wall, reply: false }).catch(() => {});
  }));
}

/** Deletes a comment and everything under it. Its author, the wall's owner and moderators may. */
export async function deleteComment(viewerId: string, commentId: string): Promise<boolean> {
  if (!mongoose.isValidObjectId(commentId)) return false;
  const comment = await WallComment.findById(commentId).lean<LeanComment>();
  if (!comment) return true;

  const viewer = await User.findById(viewerId).select('permissions').lean<LeanUser>();
  const allowed = comment.authorId.toString() === viewerId
    || comment.wallUserId.toString() === viewerId
    || (!!viewer && hasPermission(viewer.permissions, 'users.ban'));
  if (!allowed) throw new WallError('forbidden');

  const doomed: mongoose.Types.ObjectId[] = [comment._id];
  let frontier = [comment._id];
  for (let depth = comment.depth; depth < WALL_MAX_DEPTH && frontier.length > 0; depth++) {
    const children = await WallComment.find({ parentId: { $in: frontier } }).select('_id').lean<{ _id: mongoose.Types.ObjectId }[]>();
    frontier = children.map(c => c._id);
    doomed.push(...frontier);
  }
  await WallComment.deleteMany({ _id: { $in: doomed } });
  await WallCommentLike.deleteMany({ commentId: { $in: doomed } });
  return true;
}

/**
 * Likes (or unlikes) a comment for `viewerId`. Idempotent: liking twice keeps one like.
 * Anyone who can see the comment may like it, which excludes people in a block
 * relationship with the wall's owner or with the comment's author.
 */
export async function setLike(viewerId: string, commentId: string, liked: boolean): Promise<{ liked: boolean; likeCount: number }> {
  if (!mongoose.isValidObjectId(commentId)) throw new WallError('not_found');
  const comment = await WallComment.findById(commentId).lean<LeanComment>();
  if (!comment) throw new WallError('not_found');
  const owner = await User.findById(comment.wallUserId).select('isDeleted ban').lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active) throw new WallError('not_found');
  if ((await getPreferences(comment.wallUserId.toString())).wallEnabled === false) throw new WallError('wall_disabled');
  for (const otherId of new Set([comment.wallUserId.toString(), comment.authorId.toString()])) {
    if (otherId !== viewerId && await isBlockedEitherWay(viewerId, otherId)) throw new WallError('forbidden');
  }

  const key = { commentId: comment._id, userId: oid(viewerId) };
  if (liked) await WallCommentLike.updateOne(key, { $setOnInsert: key }, { upsert: true });
  else await WallCommentLike.deleteOne(key);
  return { liked, likeCount: await WallCommentLike.countDocuments({ commentId: comment._id }) };
}

export async function setSubscription(viewerId: string, accountName: string, subscribed: boolean): Promise<boolean> {
  const owner = await findOwner(accountName);
  if (owner._id.toString() === viewerId) return false;
  if (subscribed) {
    if (await isBlockedEitherWay(viewerId, owner._id.toString())) throw new WallError('forbidden');
    await WallSubscription.updateOne(
      { wallUserId: owner._id, userId: oid(viewerId) },
      { $setOnInsert: { wallUserId: owner._id, userId: oid(viewerId) } },
      { upsert: true },
    );
  } else {
    await WallSubscription.deleteOne({ wallUserId: owner._id, userId: oid(viewerId) });
  }
  return subscribed;
}
