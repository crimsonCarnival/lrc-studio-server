import mongoose from 'mongoose';
import User from '../users/user.model.js';
import type { IUser } from '../users/user.model.js';
import { WallComment, WallCommentLike, WallCommentReport, WallSubscription, WALL_MAX_DEPTH, WALL_MAX_LENGTH, WALL_REPORT_REASONS } from './wall.models.js';
import type { IWallComment } from './wall.models.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { getBlockedSet, isBlockedEitherWay } from '../blocks/block.service.js';
import { hasPermission } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import { notifyWallComment, notifyMention, notifyCommentLike } from '../notifications/notifications.events.js';
import { getIO } from '../../socket/socket.manager.js';
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
  constructor(public code: 'not_found' | 'wall_disabled' | 'forbidden' | 'invalid_body' | 'rate_limited' | 'max_depth' | 'tag_not_allowed' | 'edit_window_closed') {
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
  /** Set once the author edited the comment. */
  editedAt: string | null;
  depth: number;
  author: WallAuthor;
  canDelete: boolean;
  /** The author may still edit it (their own, within the edit window). */
  canEdit: boolean;
  /** The wall's owner pinned it to the top of the wall. */
  pinned: boolean;
  likeCount: number;
  likedByMe: boolean;
  /** The sibling this reply answers, for a reply at the deepest level; otherwise null. */
  replyToId: string | null;
  /** It answered a sibling that is no longer shown (deleted, or by someone the viewer blocked). */
  replyToMissing: boolean;
  /** Direct replies in total, and everything beneath it; `replies` may hold only the first few. */
  replyCount: number;
  descendantCount: number;
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
  /** Top-level comments that page (the pinned one is shown on every first page, not counted). */
  total: number;
  /** Every comment on the wall, replies included. */
  totalAll: number;
  /** The page returned (0-based); differs from the one asked for when `focus` chose it. */
  page: number;
  subscribed: boolean;
}

async function findOwner(accountName: string): Promise<LeanUser> {
  const owner = await User.findOne({ accountName: accountName.toLowerCase() }).lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active) throw new WallError('not_found');
  return owner;
}

/** The wall's owner, if `viewerId` may see the wall at all; throws otherwise. */
async function visibleWall(viewerId: string | null, owner: LeanUser): Promise<boolean> {
  const ownerId = owner._id.toString();
  if (viewerId && viewerId !== ownerId && await isBlockedEitherWay(viewerId, ownerId)) throw new WallError('not_found');
  return (await getPreferences(ownerId)).wallEnabled !== false;
}

const authorView = (u: LeanUser, allowsTags: boolean): WallAuthor => ({
  id: u._id.toString(),
  accountName: u.accountName ?? '',
  displayName: u.displayName ?? null,
  avatarUrl: u.avatarUrl ?? null,
  staffRole: u.role && u.role !== 'user' ? u.role : null,
  allowsTags,
});

/** How long after posting the author may still edit a comment. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** Replies sent with their parent; the rest come from wallReplies, a batch at a time. */
export const REPLY_PREVIEW = 3;

/**
 * Views of `roots` and everything beneath them as `viewerId` sees them: comments by people
 * the viewer is blocked with (and everything under those) are left out, tags resolve per
 * viewer, and each comment carries only its first REPLY_PREVIEW replies — all of them for the
 * comments in `expand` (the path to a linked comment).
 */
async function buildViews(
  viewerId: string | null,
  owner: LeanUser,
  roots: LeanComment[],
  expand: Set<string> = new Set(),
): Promise<WallCommentView[]> {
  if (roots.length === 0) return [];
  const ownerId = owner._id.toString();

  // Everything beneath the roots, one level at a time (the depth is capped, so few queries).
  const all = [...roots];
  let frontier = roots.filter(c => c.depth < WALL_MAX_DEPTH);
  while (frontier.length) {
    const children = await WallComment.find({ parentId: { $in: frontier.map(c => c._id) } }).sort({ createdAt: 1 }).lean<LeanComment[]>();
    all.push(...children);
    frontier = children.filter(c => c.depth < WALL_MAX_DEPTH);
  }

  const authorIds = [...new Set(all.map(c => c.authorId.toString()))];
  const [authors, untaggablePrefs, viewer, blockedSet, resolved] = await Promise.all([
    User.find({ _id: { $in: authorIds.map(oid) } }).select('accountName displayName avatarUrl role isDeleted').lean<LeanUser[]>(),
    UserPreferences.find({ userId: { $in: authorIds.map(oid) }, allowTags: false }).select('userId').lean(),
    viewerId ? User.findById(viewerId).select('permissions').lean<LeanUser>() : null,
    getBlockedSet(viewerId),
    resolveTags(all.map(c => c.body), viewerId),
  ]);
  const authorById = new Map(authors.map(a => [a._id.toString(), a]));
  const untaggable = new Set(untaggablePrefs.map(p => p.userId.toString()));
  const viewerIsOwner = viewerId === ownerId;
  const viewerIsStaff = !!viewer && hasPermission(viewer.permissions, 'users.ban');

  // Like counts for all of them in one aggregation, and which are the viewer's.
  const commentIds = all.map(c => c._id);
  const [likeCounts, myLikes] = await Promise.all([
    WallCommentLike.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { commentId: { $in: commentIds } } },
      { $group: { _id: '$commentId', n: { $sum: 1 } } },
    ]),
    viewerId ? WallCommentLike.find({ commentId: { $in: commentIds }, userId: oid(viewerId) }).select('commentId').lean() : [],
  ]);
  const likeCountOf = new Map(likeCounts.map(l => [l._id.toString(), l.n]));
  const likedByViewer = new Set(myLikes.map(l => l.commentId.toString()));

  const byParent = new Map<string, LeanComment[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const key = c.parentId.toString();
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const now = Date.now();

  const build = (c: LeanComment, shownSiblings: Set<string>): WallCommentView | null => {
    const author = authorById.get(c.authorId.toString());
    if (!author || author.isDeleted || blockedSet.has(c.authorId.toString())) return null;
    const children = orderSiblings(
      (byParent.get(c._id.toString()) ?? [])
        .map(r => ({ id: r._id.toString(), replyToId: r.replyToId?.toString() ?? null, doc: r })),
    );
    const visibleChildIds = new Set<string>();
    const built: WallCommentView[] = [];
    // Two passes: which children are shown decides each child's replyToMissing.
    const candidates = children.filter(ch => {
      const a = authorById.get(ch.doc.authorId.toString());
      const shown = !!a && !a.isDeleted && !blockedSet.has(ch.doc.authorId.toString());
      if (shown) visibleChildIds.add(ch.id);
      return shown;
    });
    for (const ch of candidates) {
      const v = build(ch.doc, visibleChildIds);
      if (v) built.push(v);
    }
    const isAuthor = viewerId === c.authorId.toString();
    const replyToId = c.replyToId?.toString() ?? null;
    return {
      id: c._id.toString(),
      body: c.body,
      ...tagsOf(c.body, resolved),
      createdAt: c.createdAt.toISOString(),
      editedAt: c.editedAt?.toISOString() ?? null,
      depth: c.depth,
      author: authorView(author, !untaggable.has(c.authorId.toString())),
      canDelete: isAuthor || viewerIsOwner || viewerIsStaff,
      canEdit: isAuthor && now - c.createdAt.getTime() < EDIT_WINDOW_MS,
      pinned: !!c.pinnedAt,
      likeCount: likeCountOf.get(c._id.toString()) ?? 0,
      likedByMe: likedByViewer.has(c._id.toString()),
      replyToId,
      replyToMissing: !!replyToId && !shownSiblings.has(replyToId),
      replyCount: built.length,
      descendantCount: built.reduce((n, r) => n + 1 + r.descendantCount, 0),
      replies: expand.has(c._id.toString()) ? built : built.slice(0, REPLY_PREVIEW),
    };
  };

  // Roots are siblings only when they share a parent (wallReplies); otherwise each stands alone.
  const rootIds = new Set(roots.map(r => r._id.toString()));
  // A root built on its own (a new reply, an edit, a live refetch) answers a sibling that
  // isn't among the roots, so look that sibling up rather than calling it missing.
  const outside = [...new Set(roots.map(r => r.replyToId?.toString()).filter((id): id is string => !!id && !rootIds.has(id)))];
  if (outside.length) {
    const answered = await WallComment.find({ _id: { $in: outside.map(oid) } }).select('authorId').lean<LeanComment[]>();
    const answeredAuthors = await User.find({ _id: { $in: answered.map(c => c.authorId) } }).select('isDeleted').lean<LeanUser[]>();
    const liveAuthors = new Set(answeredAuthors.filter(u => !u.isDeleted).map(u => u._id.toString()));
    for (const c of answered) {
      const authorId = c.authorId.toString();
      if (liveAuthors.has(authorId) && !blockedSet.has(authorId)) rootIds.add(c._id.toString());
    }
  }
  return roots.map(r => build(r, rootIds)).filter((v): v is WallCommentView => v !== null);
}

/** The comments above `comment`, nearest first. */
async function ancestorsOf(comment: LeanComment): Promise<LeanComment[]> {
  const out: LeanComment[] = [];
  let cur = comment;
  while (cur.parentId) {
    const parent = await WallComment.findById(cur.parentId).lean<LeanComment>();
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/**
 * One page of a wall: top-level comments newest first (the pinned one first on page 0),
 * each with its first few replies. With `focus` (a linked comment) the page holding it is
 * chosen, and the replies on the way to it are sent in full.
 */
export async function getWall(
  viewerId: string | null,
  accountName: string,
  { page: askedPage, limit, focus }: { page?: number | null; limit?: number | null; focus?: string | null } = {},
): Promise<WallView> {
  const owner = await findOwner(accountName);
  const ownerId = owner._id.toString();
  if (!(await visibleWall(viewerId, owner))) {
    return { enabled: false, comments: [], hasMore: false, total: 0, totalAll: 0, page: 0, subscribed: false };
  }

  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, limit ?? PAGE_SIZE));
  // Unpinned top-level comments page; the pinned one rides along on page 0.
  const topFilter = { wallUserId: owner._id, parentId: null, pinnedAt: null };

  let page = Math.max(0, askedPage ?? 0);
  const expand = new Set<string>();
  if (focus && mongoose.isValidObjectId(focus)) {
    const target = await WallComment.findOne({ _id: focus, wallUserId: owner._id }).lean<LeanComment>();
    if (target) {
      const above = await ancestorsOf(target);
      above.forEach(a => expand.add(a._id.toString()));
      const top = above[above.length - 1] ?? target;
      page = top.pinnedAt ? 0 : Math.floor(await WallComment.countDocuments({ ...topFilter, createdAt: { $gt: top.createdAt } }) / size);
    }
  }

  const [pinned, topPlusOne, total, totalAll] = await Promise.all([
    page === 0 ? WallComment.findOne({ wallUserId: owner._id, parentId: null, pinnedAt: { $ne: null } }).lean<LeanComment>() : null,
    WallComment.find(topFilter).sort({ createdAt: -1 }).skip(page * size).limit(size + 1).lean<LeanComment[]>(),
    WallComment.countDocuments(topFilter),
    WallComment.countDocuments({ wallUserId: owner._id }),
  ]);
  const hasMore = topPlusOne.length > size;
  const roots = [...(pinned ? [pinned] : []), ...topPlusOne.slice(0, size)];

  const subscribed = viewerId && viewerId !== ownerId
    ? !!(await WallSubscription.exists({ wallUserId: owner._id, userId: oid(viewerId) }))
    : false;

  return {
    enabled: true,
    comments: await buildViews(viewerId, owner, roots, expand),
    hasMore,
    total,
    totalAll,
    page,
    subscribed,
  };
}

/** A batch of `parentId`'s replies after the first `offset`, for "Show N more replies". */
export async function getReplies(viewerId: string | null, parentId: string, offset: number, limit: number): Promise<WallCommentView[]> {
  const parent = mongoose.isValidObjectId(parentId) ? await WallComment.findById(parentId).lean<LeanComment>() : null;
  if (!parent) throw new WallError('not_found');
  const owner = await User.findById(parent.wallUserId).lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active || !(await visibleWall(viewerId, owner))) throw new WallError('not_found');
  const children = await WallComment.find({ parentId: parent._id }).sort({ createdAt: 1 }).lean<LeanComment[]>();
  const views = orderSiblings(await buildViews(viewerId, owner, children));
  return views.slice(Math.max(0, offset), Math.max(0, offset) + Math.min(MAX_PAGE_SIZE, Math.max(1, limit)));
}

/** One comment as `viewerId` sees it (for live updates); null when it isn't shown to them. */
export async function getComment(viewerId: string | null, commentId: string): Promise<WallCommentView | null> {
  const comment = mongoose.isValidObjectId(commentId) ? await WallComment.findById(commentId).lean<LeanComment>() : null;
  if (!comment) return null;
  const owner = await User.findById(comment.wallUserId).lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active) return null;
  try {
    if (!(await visibleWall(viewerId, owner))) return null;
  } catch {
    return null;
  }
  const [view] = await buildViews(viewerId, owner, [comment]);
  return view ?? null;
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

  announce({ owner, author, authorId, answered, subscriberIds, mentionedIds: tags.userIds, commentId: created._id.toString() }).catch(() => {});
  // Everyone watching the wall fetches it as they may see it.
  emitWall(ownerId, { type: 'comment', commentId: created._id.toString(), parentId: parent?._id.toString() ?? null });

  const [view] = await buildViews(authorId, owner, [created.toObject() as unknown as LeanComment]);
  return view;
}

async function announce({ owner, author, authorId, answered, subscriberIds, mentionedIds, commentId }: {
  owner: LeanUser;
  author: LeanUser;
  authorId: string;
  answered: LeanComment | null;
  subscriberIds: string[];
  mentionedIds: string[];
  commentId: string;
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
    if (await notifyMention({ recipientId: id, actor, wallOwnerAccountName: wall, commentId }).catch(() => false)) told.add(id);
  }

  // Whoever wrote the comment being answered hears it as a reply.
  if (answered && !told.has(answered.authorId.toString())) {
    told.add(answered.authorId.toString());
    await notifyWallComment({ recipientId: answered.authorId.toString(), actor, wallOwnerAccountName: wall, reply: true, commentId }).catch(() => {});
  }
  // The wall's owner, then everyone subscribed to it.
  if (!told.has(ownerId)) {
    told.add(ownerId);
    await notifyWallComment({ recipientId: ownerId, actor, wallOwnerAccountName: wall, reply: false, commentId }).catch(() => {});
  }
  await Promise.all(subscriberIds.map(async (id) => {
    if (told.has(id)) return;
    told.add(id);
    await notifyWallComment({ recipientId: id, actor, wallOwnerAccountName: wall, reply: false, commentId }).catch(() => {});
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
  // Reports on what was removed are settled by the removal; they stay as a record.
  await WallCommentReport.updateMany(
    { commentId: { $in: doomed }, status: 'open' },
    { $set: { status: 'actioned', resolvedBy: oid(viewerId), resolvedAt: new Date() } },
  );
  emitWall(comment.wallUserId.toString(), { type: 'delete', commentId });
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
  let newLike = false;
  if (liked) newLike = (await WallCommentLike.updateOne(key, { $setOnInsert: key }, { upsert: true })).upsertedCount > 0;
  else await WallCommentLike.deleteOne(key);
  const likeCount = await WallCommentLike.countDocuments({ commentId: comment._id });
  emitWall(comment.wallUserId.toString(), { type: 'like', commentId, likeCount });

  // Only a new like is news; liking again, or unliking, tells nobody.
  if (newLike && comment.authorId.toString() !== viewerId) {
    const [actor, wallOwner] = await Promise.all([
      User.findById(viewerId).select('accountName avatarUrl').lean<LeanUser>(),
      User.findById(comment.wallUserId).select('accountName').lean<LeanUser>(),
    ]);
    if (actor && wallOwner) {
      notifyCommentLike({
        recipientId: comment.authorId.toString(),
        actor: { userId: viewerId, accountName: actor.accountName ?? '', avatarUrl: actor.avatarUrl ?? null },
        wallOwnerAccountName: wallOwner.accountName ?? '',
        commentId,
      }).catch(() => {});
    }
  }
  return { liked, likeCount };
}

/** Who liked a comment, newest first, as people the viewer may see. */
export async function getLikers(viewerId: string | null, commentId: string, limit = 20): Promise<{ users: WallAuthor[]; total: number }> {
  const comment = mongoose.isValidObjectId(commentId) ? await WallComment.findById(commentId).lean<LeanComment>() : null;
  if (!comment) throw new WallError('not_found');
  const owner = await User.findById(comment.wallUserId).lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active || !(await visibleWall(viewerId, owner))) throw new WallError('not_found');
  const [likes, total, blockedSet] = await Promise.all([
    WallCommentLike.find({ commentId: comment._id }).sort({ createdAt: -1 }).limit(Math.min(50, Math.max(1, limit))).lean(),
    WallCommentLike.countDocuments({ commentId: comment._id }),
    getBlockedSet(viewerId),
  ]);
  const users = await User.find({ _id: { $in: likes.map(l => l.userId) }, isDeleted: { $ne: true } })
    .select('accountName displayName avatarUrl role').lean<LeanUser[]>();
  const byId = new Map(users.map(u => [u._id.toString(), u]));
  return {
    users: likes
      .map(l => byId.get(l.userId.toString()))
      .filter((u): u is LeanUser => !!u && !blockedSet.has(u._id.toString()))
      .map(u => authorView(u, true)),
    total,
  };
}

/**
 * Edits a comment: its author only, within EDIT_WINDOW_MS of posting. The new body is
 * checked like a new comment, and only people newly tagged by the edit are told.
 */
export async function editComment(viewerId: string, commentId: string, rawBody: string): Promise<WallCommentView> {
  const comment = mongoose.isValidObjectId(commentId) ? await WallComment.findById(commentId).lean<LeanComment>() : null;
  if (!comment) throw new WallError('not_found');
  if (comment.authorId.toString() !== viewerId) throw new WallError('forbidden');
  if (Date.now() - comment.createdAt.getTime() >= EDIT_WINDOW_MS) throw new WallError('edit_window_closed');
  const owner = await User.findById(comment.wallUserId).lean<LeanUser>();
  if (!owner || owner.isDeleted || owner.ban?.active || !(await visibleWall(viewerId, owner))) throw new WallError('not_found');

  const body = stripHtml(rawBody ?? '').trim();
  if (body.length < 1 || body.length > WALL_MAX_LENGTH) throw new WallError('invalid_body');
  const tags = parseTags(body);
  const tagCheck = await checkTags(viewerId, tags);
  if (tagCheck === 'invalid') throw new WallError('invalid_body');
  if (tagCheck === 'not_allowed') throw new WallError('tag_not_allowed');

  const editedAt = new Date();
  await WallComment.updateOne({ _id: comment._id }, { $set: { body, editedAt } });

  const before = new Set(parseTags(comment.body).userIds);
  const added = tags.userIds.filter(id => !before.has(id) && id !== viewerId);
  if (added.length) {
    const author = await User.findById(viewerId).select('accountName avatarUrl').lean<LeanUser>();
    const actor = { userId: viewerId, accountName: author?.accountName ?? '', avatarUrl: author?.avatarUrl ?? null };
    for (const id of added) {
      if (await isBlockedEitherWay(id, owner._id.toString())) continue;
      notifyMention({ recipientId: id, actor, wallOwnerAccountName: owner.accountName ?? '', commentId }).catch(() => {});
    }
  }
  emitWall(owner._id.toString(), { type: 'edit', commentId });

  const [view] = await buildViews(viewerId, owner, [{ ...comment, body, editedAt }]);
  return view;
}

/** Pins (or unpins) a top-level comment; the wall's owner only, one pinned comment per wall. */
export async function setPin(viewerId: string, commentId: string, pinned: boolean): Promise<boolean> {
  const comment = mongoose.isValidObjectId(commentId) ? await WallComment.findById(commentId).lean<LeanComment>() : null;
  if (!comment) throw new WallError('not_found');
  if (comment.wallUserId.toString() !== viewerId) throw new WallError('forbidden');
  if (comment.parentId) throw new WallError('forbidden'); // replies follow their thread
  if (pinned) {
    await WallComment.updateMany({ wallUserId: comment.wallUserId, pinnedAt: { $ne: null } }, { $set: { pinnedAt: null } });
    await WallComment.updateOne({ _id: comment._id }, { $set: { pinnedAt: new Date() } });
  } else {
    await WallComment.updateOne({ _id: comment._id }, { $set: { pinnedAt: null } });
  }
  emitWall(viewerId, { type: 'pin', commentId: pinned ? commentId : null });
  return pinned;
}

/**
 * Reports a comment to the moderators. Anyone who can see it, except its author; reporting
 * the same comment again updates the reason and reopens a settled report.
 */
export async function reportComment(viewerId: string, commentId: string, reason: string, rawNote: string | null | undefined): Promise<boolean> {
  if (!(WALL_REPORT_REASONS as readonly string[]).includes(reason)) throw new WallError('invalid_body');
  const comment = await getComment(viewerId, commentId);
  if (!comment) throw new WallError('not_found');
  if (comment.author.id === viewerId) throw new WallError('forbidden');
  const doc = await WallComment.findById(commentId).select('wallUserId').lean<LeanComment>();
  if (!doc) throw new WallError('not_found');
  const note = stripHtml(rawNote ?? '').trim().slice(0, 300);
  await WallCommentReport.updateOne(
    { commentId: oid(commentId), reporterId: oid(viewerId) },
    {
      $set: { reason, note, status: 'open', resolvedBy: null, resolvedAt: null },
      $setOnInsert: { commentId: oid(commentId), reporterId: oid(viewerId), wallUserId: doc.wallUserId },
    },
    { upsert: true },
  );
  return true;
}

export interface WallReportView {
  id: string;
  reason: string;
  note: string;
  status: string;
  createdAt: string;
  /** How many open reports this comment has, this one included. */
  openCount: number;
  reporter: WallAuthor | null;
  wallAccountName: string;
  comment: { id: string; body: string; author: WallAuthor | null; createdAt: string } | null;
}

async function requireModerator(viewerId: string): Promise<void> {
  const viewer = await User.findById(viewerId).select('permissions').lean<LeanUser>();
  if (!viewer || !hasPermission(viewer.permissions, 'users.ban')) throw new WallError('forbidden');
}

/** Reports for moderators (users.ban), oldest open first. */
export async function listReports(viewerId: string, status: 'open' | 'dismissed' | 'actioned' = 'open', limit = 50): Promise<WallReportView[]> {
  await requireModerator(viewerId);
  const reports = await WallCommentReport.find({ status }).sort({ createdAt: status === 'open' ? 1 : -1 }).limit(Math.min(100, Math.max(1, limit))).lean();
  const commentIds = [...new Set(reports.map(r => r.commentId.toString()))];
  const comments = await WallComment.find({ _id: { $in: commentIds } }).lean<LeanComment[]>();
  const userIds = [...new Set([
    ...reports.map(r => r.reporterId.toString()),
    ...reports.map(r => r.wallUserId.toString()),
    ...comments.map(c => c.authorId.toString()),
  ])];
  const [users, openCounts] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('accountName displayName avatarUrl role').lean<LeanUser[]>(),
    WallCommentReport.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { commentId: { $in: commentIds.map(oid) }, status: 'open' } },
      { $group: { _id: '$commentId', n: { $sum: 1 } } },
    ]),
  ]);
  const userById = new Map(users.map(u => [u._id.toString(), u]));
  const commentById = new Map(comments.map(c => [c._id.toString(), c]));
  const openCountOf = new Map(openCounts.map(o => [o._id.toString(), o.n]));
  const view = (id: string) => { const u = userById.get(id); return u ? authorView(u, true) : null; };
  return reports.map(r => {
    const c = commentById.get(r.commentId.toString());
    return {
      id: r._id.toString(),
      reason: r.reason,
      note: r.note,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      openCount: openCountOf.get(r.commentId.toString()) ?? 0,
      reporter: view(r.reporterId.toString()),
      wallAccountName: userById.get(r.wallUserId.toString())?.accountName ?? '',
      comment: c ? { id: c._id.toString(), body: c.body, author: view(c.authorId.toString()), createdAt: c.createdAt.toISOString() } : null,
    };
  });
}

/**
 * Settles a report. 'delete' removes the comment (and with it every open report on it);
 * 'dismiss' closes this comment's open reports without touching it.
 */
export async function resolveReport(viewerId: string, reportId: string, action: 'dismiss' | 'delete'): Promise<boolean> {
  await requireModerator(viewerId);
  const report = mongoose.isValidObjectId(reportId) ? await WallCommentReport.findById(reportId).lean() : null;
  if (!report) throw new WallError('not_found');
  if (action === 'delete') {
    await deleteComment(viewerId, report.commentId.toString());
    // Already-deleted comment: still close its reports.
    await WallCommentReport.updateMany(
      { commentId: report.commentId, status: 'open' },
      { $set: { status: 'actioned', resolvedBy: oid(viewerId), resolvedAt: new Date() } },
    );
  } else {
    await WallCommentReport.updateMany(
      { commentId: report.commentId, status: 'open' },
      { $set: { status: 'dismissed', resolvedBy: oid(viewerId), resolvedAt: new Date() } },
    );
  }
  return true;
}

/** Tells everyone watching `ownerId`'s wall that something changed; they refetch what they need. */
type WallEvent =
  | { type: 'comment'; commentId: string; parentId: string | null }
  | { type: 'edit'; commentId: string }
  | { type: 'delete'; commentId: string }
  | { type: 'like'; commentId: string; likeCount: number }
  | { type: 'pin'; commentId: string | null };

function emitWall(ownerId: string, event: WallEvent): void {
  try { getIO().to(`wall:${ownerId}`).emit('wall:event', event); } catch { /* socket not ready (tests, startup) */ }
}

/** Whether `viewerId` may watch `accountName`'s wall live; returns the room to join. */
export async function wallRoom(viewerId: string | null, accountName: string): Promise<string | null> {
  try {
    const owner = await findOwner(accountName);
    if (!(await visibleWall(viewerId, owner))) return null;
    return `wall:${owner._id.toString()}`;
  } catch {
    return null;
  }
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
