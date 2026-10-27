import mongoose from 'mongoose';
import User from '../users/user.model.js';
import type { IUser } from '../users/user.model.js';
import {
  WallComment, WallCommentLike, WallCommentReaction, WallCommentReport, WallRestriction, WallSubscription, WallThreadMute,
  WALL_MAX_DEPTH, WALL_MAX_LENGTH, WALL_REPORT_REASONS,
} from './wall.models.js';
import type { IWallComment, WallCommentStatus } from './wall.models.js';
import Follow from '../users/follow.model.js';
import { blockUser } from '../blocks/block.service.js';
import { isValidReaction } from '../reactions/reaction.emoji.js';
import { logAdminAction } from '../admin/admin.service.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { getBlockedSet, isBlockedEitherWay } from '../blocks/block.service.js';
import { hasPermission, rankOf } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import {
  notifyWallComment, notifyMention, notifyCommentLike, notifyWallReport, notifyWallReportReviewed, notifyWallRestricted,
} from '../notifications/notifications.events.js';
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
  constructor(public code: 'not_found' | 'wall_disabled' | 'forbidden' | 'invalid_body' | 'rate_limited' | 'max_depth' | 'tag_not_allowed' | 'edit_window_closed' | 'comments_closed' | 'restricted') {
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
  /** visible to everyone, pending the owner's approval, or hidden by the owner or a moderator. */
  status: WallCommentStatus;
  /** For a pending comment: held by the owner's approval setting, or for a muted word. */
  heldReason: 'approval' | 'muted_word' | null;
  /** The viewer may approve, hide and unhide it (the wall's owner, or a moderator). */
  canModerate: boolean;
  /** How many times it was edited; the history comes from wallCommentHistory. */
  revisionCount: number;
  reactions: WallReactionCount[];
  /** For a top-level comment: the viewer stopped hearing about replies in its thread. */
  mutedByMe: boolean;
}

export interface WallReactionCount {
  emoji: string;
  count: number;
  mine: boolean;
}

export const WALL_SORTS = ['newest', 'oldest', 'top'] as const;
export type WallSort = (typeof WALL_SORTS)[number];

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
  sort: WallSort;
  /** The viewer may post (signed in, allowed by the owner's setting, not restricted). */
  canComment: boolean;
  /** The owner's setting: everyone, following or nobody. */
  commentPolicy: 'everyone' | 'following' | 'nobody';
  /** The viewer's own commenting restriction, if a moderator set one (ISO; 'forever' when open-ended). */
  restrictedUntil: string | null;
  /** For the owner and moderators: comments waiting for approval. */
  pendingCount: number;
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

const isModerator = async (viewerId: string | null): Promise<boolean> => {
  if (!viewerId) return false;
  const viewer = await User.findById(viewerId).select('permissions').lean<LeanUser>();
  return !!viewer && hasPermission(viewer.permissions, 'users.ban');
};

/** Comments a viewer may see: the visible ones, their own, and everything for the owner and moderators. */
function statusFilter(viewerId: string | null, ownerId: string, moderator: boolean): Record<string, unknown> {
  if (viewerId === ownerId || moderator) return {};
  const visible = { status: { $in: ['visible', null] } };
  return viewerId ? { $or: [visible, { authorId: oid(viewerId) }] } : visible;
}

/** The viewer's active commenting restriction, if any. */
async function activeRestriction(userId: string): Promise<{ until: Date | null } | null> {
  const r = await WallRestriction.findOne({ userId: oid(userId) }).lean();
  if (!r) return null;
  if (r.until && r.until.getTime() <= Date.now()) return null;
  return { until: r.until };
}

/** Why `authorId` may not comment on `owner`'s wall, or null when they may. */
async function commentBlocker(authorId: string, ownerId: string, policy: string): Promise<'comments_closed' | 'restricted' | null> {
  if (await activeRestriction(authorId)) return 'restricted';
  if (authorId === ownerId) return null;
  if (policy === 'nobody') return 'comments_closed';
  if (policy === 'following' && !(await Follow.exists({ followerId: oid(ownerId), followingId: oid(authorId) }))) return 'comments_closed';
  return null;
}

const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60_000;

/** Whether a new (or edited) comment waits for the owner: their hold setting, or a muted word. */
async function holdReason(authorId: string, ownerId: string, body: string): Promise<'approval' | 'muted_word' | null> {
  if (authorId === ownerId) return null;
  const prefs = await getPreferences(ownerId);
  const lower = body.toLowerCase();
  if ((prefs.wallMutedWords ?? []).some(w => w && lower.includes(w))) return 'muted_word';
  switch (prefs.wallHoldFrom) {
    case 'everyone': return 'approval';
    case 'not_followed':
      return (await Follow.exists({ followerId: oid(ownerId), followingId: oid(authorId) })) ? null : 'approval';
    case 'new_accounts': {
      const author = await User.findById(authorId).select('createdAt').lean<LeanUser>();
      return author?.createdAt && Date.now() - new Date(author.createdAt).getTime() < NEW_ACCOUNT_MS ? 'approval' : null;
    }
    default: return null;
  }
}

/** The top-level comment a comment's thread hangs from. */
async function rootOf(comment: LeanComment): Promise<LeanComment> {
  const above = await ancestorsOf(comment);
  return above[above.length - 1] ?? comment;
}

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

  // Reactions per comment and emoji, oldest emoji first; and the viewer's thread mutes.
  const [reactionRows, mutes] = await Promise.all([
    WallCommentReaction.aggregate<{ _id: { c: mongoose.Types.ObjectId; e: string }; n: number; mine: number; first: Date }>([
      { $match: { commentId: { $in: commentIds } } },
      {
        $group: {
          _id: { c: '$commentId', e: '$emoji' },
          n: { $sum: 1 },
          mine: { $sum: { $cond: [{ $eq: ['$userId', viewerId ? oid(viewerId) : null] }, 1, 0] } },
          first: { $min: '$createdAt' },
        },
      },
      { $sort: { first: 1 } },
    ]),
    viewerId
      ? WallThreadMute.find({ userId: oid(viewerId), rootId: { $in: all.filter(c => !c.parentId).map(c => c._id) } }).select('rootId').lean()
      : [],
  ]);
  const reactionsOf = new Map<string, WallReactionCount[]>();
  for (const r of reactionRows) {
    const key = r._id.c.toString();
    reactionsOf.set(key, [...(reactionsOf.get(key) ?? []), { emoji: r._id.e, count: r.n, mine: r.mine > 0 }]);
  }
  const mutedRoots = new Set(mutes.map(m => m.rootId.toString()));
  // Held and hidden comments: the owner, moderators and the comment's author see them.
  const canSee = (c: LeanComment) => !c.status || c.status === 'visible' || viewerIsOwner || viewerIsStaff || c.authorId.toString() === viewerId;

  const byParent = new Map<string, LeanComment[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const key = c.parentId.toString();
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const now = Date.now();

  const build = (c: LeanComment, shownSiblings: Set<string>): WallCommentView | null => {
    const author = authorById.get(c.authorId.toString());
    if (!author || author.isDeleted || blockedSet.has(c.authorId.toString()) || !canSee(c)) return null;
    const children = orderSiblings(
      (byParent.get(c._id.toString()) ?? [])
        .map(r => ({ id: r._id.toString(), replyToId: r.replyToId?.toString() ?? null, doc: r })),
    );
    const visibleChildIds = new Set<string>();
    const built: WallCommentView[] = [];
    // Two passes: which children are shown decides each child's replyToMissing.
    const candidates = children.filter(ch => {
      const a = authorById.get(ch.doc.authorId.toString());
      const shown = !!a && !a.isDeleted && !blockedSet.has(ch.doc.authorId.toString()) && canSee(ch.doc);
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
      status: c.status ?? 'visible',
      heldReason: c.status === 'pending' ? (c.heldReason ?? 'approval') : null,
      canModerate: viewerIsOwner || viewerIsStaff,
      revisionCount: c.revisions?.length ?? 0,
      reactions: reactionsOf.get(c._id.toString()) ?? [],
      mutedByMe: mutedRoots.has(c._id.toString()),
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
 * One page of a wall: top-level comments newest first (or oldest first, or most liked), the
 * pinned one first on page 0, each with its first few replies. With `focus` (a linked
 * comment) the page holding it is chosen, newest first, and the replies on the way to it are
 * sent in full. Held and hidden comments are only listed for those who may see them.
 */
export async function getWall(
  viewerId: string | null,
  accountName: string,
  { page: askedPage, limit, focus, sort: askedSort }: { page?: number | null; limit?: number | null; focus?: string | null; sort?: string | null } = {},
): Promise<WallView> {
  const owner = await findOwner(accountName);
  const ownerId = owner._id.toString();
  let sort: WallSort = (WALL_SORTS as readonly string[]).includes(askedSort ?? '') ? askedSort as WallSort : 'newest';
  const prefs = await getPreferences(ownerId);
  const commentPolicy = prefs.wallWhoCanComment ?? 'everyone';
  if (!(await visibleWall(viewerId, owner))) {
    return {
      enabled: false, comments: [], hasMore: false, total: 0, totalAll: 0, page: 0, subscribed: false,
      sort, canComment: false, commentPolicy, restrictedUntil: null, pendingCount: 0,
    };
  }

  const moderator = await isModerator(viewerId);
  const seen = statusFilter(viewerId, ownerId, moderator);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, limit ?? PAGE_SIZE));
  // Unpinned top-level comments page; the pinned one rides along on page 0.
  const topFilter = { wallUserId: owner._id, parentId: null, pinnedAt: null, ...seen };

  let page = Math.max(0, askedPage ?? 0);
  const expand = new Set<string>();
  if (focus && mongoose.isValidObjectId(focus)) {
    const target = await WallComment.findOne({ _id: focus, wallUserId: owner._id }).lean<LeanComment>();
    if (target) {
      sort = 'newest';
      const above = await ancestorsOf(target);
      above.forEach(a => expand.add(a._id.toString()));
      const top = above[above.length - 1] ?? target;
      page = top.pinnedAt ? 0 : Math.floor(await WallComment.countDocuments({ ...topFilter, createdAt: { $gt: top.createdAt } }) / size);
    }
  }

  const pageOf = async (): Promise<LeanComment[]> => {
    if (sort !== 'top') {
      return WallComment.find(topFilter).sort({ createdAt: sort === 'oldest' ? 1 : -1 }).skip(page * size).limit(size + 1).lean<LeanComment[]>();
    }
    // Most liked first, then newest.
    return WallComment.aggregate<LeanComment>([
      { $match: topFilter },
      { $lookup: { from: 'wall_comment_likes', localField: '_id', foreignField: 'commentId', as: 'likes', pipeline: [{ $project: { _id: 1 } }] } },
      { $addFields: { likeTotal: { $size: '$likes' } } },
      { $sort: { likeTotal: -1, createdAt: -1 } },
      { $skip: page * size },
      { $limit: size + 1 },
      { $project: { likes: 0, likeTotal: 0 } },
    ]);
  };

  const [pinned, topPlusOne, total, totalAll, pendingCount] = await Promise.all([
    page === 0 ? WallComment.findOne({ wallUserId: owner._id, parentId: null, pinnedAt: { $ne: null }, ...seen }).lean<LeanComment>() : null,
    pageOf(),
    WallComment.countDocuments(topFilter),
    WallComment.countDocuments({ wallUserId: owner._id, ...seen }),
    viewerId === ownerId || moderator ? WallComment.countDocuments({ wallUserId: owner._id, status: 'pending' }) : 0,
  ]);
  const hasMore = topPlusOne.length > size;
  const roots = [...(pinned ? [pinned] : []), ...topPlusOne.slice(0, size)];

  const subscribed = viewerId && viewerId !== ownerId
    ? !!(await WallSubscription.exists({ wallUserId: owner._id, userId: oid(viewerId) }))
    : false;
  const restriction = viewerId ? await activeRestriction(viewerId) : null;
  const blocker = viewerId ? await commentBlocker(viewerId, ownerId, commentPolicy) : 'comments_closed';

  return {
    enabled: true,
    comments: await buildViews(viewerId, owner, roots, expand),
    hasMore,
    total,
    totalAll,
    page,
    subscribed,
    sort,
    canComment: !blocker,
    commentPolicy,
    restrictedUntil: restriction ? (restriction.until?.toISOString() ?? 'forever') : null,
    pendingCount,
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
  const prefs = await getPreferences(ownerId);
  if (prefs.wallEnabled === false) throw new WallError('wall_disabled');
  const blocker = await commentBlocker(authorId, ownerId, prefs.wallWhoCanComment ?? 'everyone');
  if (blocker) throw new WallError(blocker);

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

  const held = await holdReason(authorId, ownerId, body);
  const created = await WallComment.create({
    wallUserId: owner._id,
    authorId: oid(authorId),
    parentId: parent?._id ?? null,
    replyToId: answered && answered._id.toString() !== parent?._id.toString() ? answered._id : null,
    depth,
    body,
    status: held ? 'pending' : 'visible',
    heldReason: held,
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

  // A held comment is news to the owner only; the rest hear about it once it is approved.
  if (held) {
    notifyWallComment({
      recipientId: ownerId,
      actor: { userId: authorId, accountName: author.accountName ?? '', avatarUrl: author.avatarUrl ?? null },
      wallOwnerAccountName: owner.accountName ?? '',
      reply: false,
      commentId: created._id.toString(),
    }).catch(() => {});
  } else {
    announce({ owner, author, authorId, answered, subscriberIds, mentionedIds: tags.userIds, commentId: created._id.toString() }).catch(() => {});
  }
  // Everyone watching the wall fetches it as they may see it.
  emitWall(ownerId, { type: 'comment', commentId: created._id.toString(), parentId: parent?._id.toString() ?? null });

  const [view] = await buildViews(authorId, owner, [created.toObject() as unknown as LeanComment]);
  return view;
}

async function announce({ owner, author, authorId, answered, subscriberIds, mentionedIds, commentId, skip = [] }: {
  owner: LeanUser;
  author: LeanUser;
  authorId: string;
  answered: LeanComment | null;
  subscriberIds: string[];
  mentionedIds: string[];
  commentId: string;
  /** Already told (the owner, when a held comment is approved). */
  skip?: string[];
}): Promise<void> {
  const ownerId = owner._id.toString();
  const actor = { userId: authorId, accountName: author.accountName ?? '', avatarUrl: author.avatarUrl ?? null };
  const wall = owner.accountName ?? '';
  const told = new Set<string>([authorId, ...skip]);
  // People who muted this thread hear nothing about replies in it (a tag still reaches them).
  if (answered) {
    const root = await rootOf(answered);
    const muted = await WallThreadMute.find({ rootId: root._id }).select('userId').lean();
    for (const m of muted) {
      const id = m.userId.toString();
      if (!mentionedIds.includes(id)) told.add(id);
    }
  }

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
  await WallCommentReaction.deleteMany({ commentId: { $in: doomed } });
  await WallThreadMute.deleteMany({ rootId: { $in: doomed } });
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
  // An edit that brings in a muted word sends a visible comment back for approval.
  const held = (comment.status ?? 'visible') === 'visible' && await holdReason(viewerId, owner._id.toString(), body) === 'muted_word';
  await WallComment.updateOne(
    { _id: comment._id },
    {
      $set: { body, editedAt, ...(held ? { status: 'pending', heldReason: 'muted_word' } : {}) },
      $push: { revisions: { body: comment.body, editedAt: comment.editedAt ?? comment.createdAt } },
    },
  );

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

  const revisions = [...(comment.revisions ?? []), { body: comment.body, editedAt: comment.editedAt ?? comment.createdAt }];
  const [view] = await buildViews(viewerId, owner, [{
    ...comment, body, editedAt, revisions,
    ...(held ? { status: 'pending' as const, heldReason: 'muted_word' as const } : {}),
  }]);
  return view;
}

/** The comment, its wall's owner, and whether `viewerId` moderates it (the owner, or staff with users.ban). */
async function moderatedComment(viewerId: string, commentId: string): Promise<{ comment: LeanComment; owner: LeanUser; asStaff: boolean }> {
  const comment = mongoose.isValidObjectId(commentId) ? await WallComment.findById(commentId).lean<LeanComment>() : null;
  if (!comment) throw new WallError('not_found');
  const owner = await User.findById(comment.wallUserId).lean<LeanUser>();
  if (!owner || owner.isDeleted) throw new WallError('not_found');
  if (owner._id.toString() === viewerId) return { comment, owner, asStaff: false };
  if (await isModerator(viewerId)) return { comment, owner, asStaff: true };
  throw new WallError('forbidden');
}

/**
 * The owner (or a moderator) approves a held comment, rejects it (deleting it), or hides or
 * unhides one. An approved comment is announced the way a new one is; the owner already heard.
 */
export async function moderateComment(viewerId: string, commentId: string, action: 'approve' | 'reject' | 'hide' | 'unhide', ip?: string | null): Promise<boolean> {
  const { comment, owner, asStaff } = await moderatedComment(viewerId, commentId);
  const ownerId = owner._id.toString();
  const status = comment.status ?? 'visible';
  if (action === 'reject') {
    if (status !== 'pending') throw new WallError('forbidden');
    await deleteComment(viewerId, commentId);
  } else if (action === 'approve') {
    if (status !== 'pending') return true;
    await WallComment.updateOne({ _id: comment._id }, { $set: { status: 'visible', heldReason: null } });
    const [author, answered, subscribers] = await Promise.all([
      User.findById(comment.authorId).select('accountName displayName avatarUrl role').lean<LeanUser>(),
      comment.replyToId ? WallComment.findById(comment.replyToId).lean<LeanComment>()
        : comment.parentId ? WallComment.findById(comment.parentId).lean<LeanComment>() : null,
      WallSubscription.find({ wallUserId: owner._id }).limit(MAX_SUBSCRIBER_FANOUT).select('userId').lean<{ userId: mongoose.Types.ObjectId }[]>(),
    ]);
    if (author) {
      announce({
        owner, author, authorId: comment.authorId.toString(), answered,
        subscriberIds: subscribers.map(x => x.userId.toString()),
        mentionedIds: parseTags(comment.body).userIds, commentId, skip: [ownerId],
      }).catch(() => {});
    }
  } else {
    const next = action === 'hide' ? 'hidden' : 'visible';
    if (action === 'unhide' && status !== 'hidden') return true;
    await WallComment.updateOne({ _id: comment._id }, { $set: { status: next } });
  }
  if (asStaff) {
    const author = await User.findById(comment.authorId).select('accountName').lean<LeanUser>();
    await logAdminAction({
      adminId: viewerId, action: `wall_comment_${action}`, targetId: comment.authorId.toString(),
      targetName: author?.accountName ?? null, details: `On ${owner.accountName}'s wall: ${comment.body.slice(0, 200)}`, ip,
    }).catch(() => {});
  }
  emitWall(ownerId, { type: 'reload' });
  return true;
}

/**
 * Deletes everything `authorId` wrote on `wallAccountName`'s wall (with the replies beneath).
 * The wall's owner or a moderator; returns how many of their comments went.
 */
export async function purgeAuthorComments(viewerId: string, wallAccountName: string, authorId: string, ip?: string | null): Promise<number> {
  if (!mongoose.isValidObjectId(authorId)) throw new WallError('not_found');
  const owner = await User.findOne({ accountName: wallAccountName.toLowerCase() }).lean<LeanUser>();
  if (!owner) throw new WallError('not_found');
  const asStaff = owner._id.toString() !== viewerId;
  if (asStaff && !(await isModerator(viewerId))) throw new WallError('forbidden');
  const theirs = await WallComment.find({ wallUserId: owner._id, authorId: oid(authorId) }).sort({ depth: 1 }).select('_id').lean<LeanComment[]>();
  // Shallowest first: deleting a comment takes its replies with it, so later ids may be gone already.
  for (const c of theirs) await deleteComment(viewerId, c._id.toString());
  if (asStaff && theirs.length) {
    const author = await User.findById(authorId).select('accountName').lean<LeanUser>();
    await logAdminAction({
      adminId: viewerId, action: 'wall_comments_purge', targetId: authorId, targetName: author?.accountName ?? null,
      details: `${theirs.length} comment(s) on ${owner.accountName}'s wall`, ip,
    }).catch(() => {});
  }
  emitWall(owner._id.toString(), { type: 'reload' });
  return theirs.length;
}

/** The wall's owner blocks a commenter and removes everything they wrote on the wall. */
export async function blockCommenter(viewerId: string, authorId: string): Promise<number> {
  if (!mongoose.isValidObjectId(authorId) || authorId === viewerId) throw new WallError('forbidden');
  const owner = await User.findById(viewerId).select('accountName').lean<LeanUser>();
  if (!owner?.accountName) throw new WallError('not_found');
  await blockUser(viewerId, authorId);
  return purgeAuthorComments(viewerId, owner.accountName, authorId);
}

/** A comment's earlier versions, oldest first, then the current one; for anyone who can see it. */
export async function getCommentHistory(viewerId: string | null, commentId: string): Promise<{ body: string; editedAt: string; current: boolean }[]> {
  const view = await getComment(viewerId, commentId);
  if (!view) throw new WallError('not_found');
  const comment = await WallComment.findById(commentId).select('body revisions createdAt editedAt').lean<LeanComment>();
  if (!comment) throw new WallError('not_found');
  return [
    ...(comment.revisions ?? []).map(r => ({ body: r.body, editedAt: r.editedAt.toISOString(), current: false })),
    { body: comment.body, editedAt: (comment.editedAt ?? comment.createdAt).toISOString(), current: true },
  ];
}

/** Stops (or resumes) telling `viewerId` about replies in the thread `commentId` belongs to. */
export async function setThreadMute(viewerId: string, commentId: string, muted: boolean): Promise<boolean> {
  const view = await getComment(viewerId, commentId);
  if (!view) throw new WallError('not_found');
  const comment = await WallComment.findById(commentId).lean<LeanComment>();
  if (!comment) throw new WallError('not_found');
  const root = await rootOf(comment);
  const key = { userId: oid(viewerId), rootId: root._id };
  if (muted) await WallThreadMute.updateOne(key, { $setOnInsert: key }, { upsert: true });
  else await WallThreadMute.deleteOne(key);
  return muted;
}

/** Adds (or takes back) the viewer's `emoji` reaction on a comment; who may is as for likes. */
export async function setReaction(viewerId: string, commentId: string, emoji: string, on: boolean): Promise<WallReactionCount[]> {
  if (!isValidReaction(emoji)) throw new WallError('invalid_body');
  const comment = mongoose.isValidObjectId(commentId) ? await WallComment.findById(commentId).lean<LeanComment>() : null;
  if (!comment || !(await getComment(viewerId, commentId))) throw new WallError('not_found');
  if ((await getPreferences(comment.wallUserId.toString())).wallEnabled === false) throw new WallError('wall_disabled');
  for (const otherId of new Set([comment.wallUserId.toString(), comment.authorId.toString()])) {
    if (otherId !== viewerId && await isBlockedEitherWay(viewerId, otherId)) throw new WallError('forbidden');
  }
  const key = { commentId: comment._id, userId: oid(viewerId), emoji };
  if (on) {
    // A handful of different emoji per person per comment is plenty.
    if (await WallCommentReaction.countDocuments({ commentId: comment._id, userId: oid(viewerId) }) >= 6
      && !(await WallCommentReaction.exists(key))) throw new WallError('rate_limited');
    await WallCommentReaction.updateOne(key, { $setOnInsert: key }, { upsert: true });
  } else {
    await WallCommentReaction.deleteOne(key);
  }
  emitWall(comment.wallUserId.toString(), { type: 'reaction', commentId });
  const view = await getComment(viewerId, commentId);
  return view?.reactions ?? [];
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

// Per reporter: enough for a bad day on a busy wall, not enough to flood the queue.
const REPORT_LIMIT_COUNT = 20;
const REPORT_LIMIT_WINDOW_MS = 60 * 60_000;

/** Moderators (users.ban) who hear about new reports. */
async function moderatorIds(): Promise<string[]> {
  const mods = await User.find({ permissions: 'users.ban', isDeleted: { $ne: true }, 'ban.active': { $ne: true } }).select('_id').limit(200).lean<LeanUser[]>();
  return mods.map(m => m._id.toString());
}

/** Comments with open reports: the count on the moderators' Reports tab. */
export async function openReportCount(): Promise<number> {
  return (await WallCommentReport.distinct('commentId', { status: 'open' })).length;
}

/** Tells moderators watching the dashboard that the queue changed. */
async function emitReportQueue(): Promise<void> {
  try { getIO().to('admin').emit('admin:wall_reports', { open: await openReportCount() }); } catch { /* socket not ready */ }
}

/**
 * Reports a comment to the moderators. Anyone signed in who can see it, except its author;
 * reporting the same comment again updates the reason and reopens a settled report. A new
 * report reaches the moderators at once (a notification, and the dashboard's live count).
 */
export async function reportComment(viewerId: string, commentId: string, reason: string, rawNote: string | null | undefined): Promise<boolean> {
  if (!(WALL_REPORT_REASONS as readonly string[]).includes(reason)) throw new WallError('invalid_body');
  const comment = await getComment(viewerId, commentId);
  if (!comment) throw new WallError('not_found');
  if (comment.author.id === viewerId) throw new WallError('forbidden');
  const doc = await WallComment.findById(commentId).select('wallUserId authorId').lean<LeanComment>();
  if (!doc) throw new WallError('not_found');
  const recent = await WallCommentReport.countDocuments({ reporterId: oid(viewerId), createdAt: { $gte: new Date(Date.now() - REPORT_LIMIT_WINDOW_MS) } });
  if (recent >= REPORT_LIMIT_COUNT) throw new WallError('rate_limited');
  const note = stripHtml(rawNote ?? '').trim().slice(0, 300);
  const previous = await WallCommentReport.findOne({ commentId: oid(commentId), reporterId: oid(viewerId) }).select('status').lean();
  await WallCommentReport.updateOne(
    { commentId: oid(commentId), reporterId: oid(viewerId) },
    {
      // createdAt is reset too, so a reopened report sits at the end of the queue and counts toward the limit.
      $set: { reason, note, status: 'open', resolvedBy: null, resolvedAt: null, createdAt: new Date() },
      $setOnInsert: { commentId: oid(commentId), reporterId: oid(viewerId), wallUserId: doc.wallUserId, authorId: doc.authorId },
    },
    { upsert: true, timestamps: false },
  );
  // Updating a report that is still open is not news.
  if (previous?.status !== 'open') {
    const [reporter, wallOwner] = await Promise.all([
      User.findById(viewerId).select('accountName avatarUrl').lean<LeanUser>(),
      User.findById(doc.wallUserId).select('accountName').lean<LeanUser>(),
    ]);
    notifyWallReport({
      moderatorIds: await moderatorIds(),
      actor: { userId: viewerId, accountName: reporter?.accountName ?? '', avatarUrl: reporter?.avatarUrl ?? null },
      wallOwnerAccountName: wallOwner?.accountName ?? '',
      commentId,
    }).catch(() => {});
    emitReportQueue().catch(() => {});
  }
  return true;
}

type ReportStatus = 'open' | 'dismissed' | 'actioned';
type LeanReport = { _id: mongoose.Types.ObjectId; commentId: mongoose.Types.ObjectId; wallUserId: mongoose.Types.ObjectId; reporterId: mongoose.Types.ObjectId; authorId?: mongoose.Types.ObjectId | null; reason: string; note: string; status: ReportStatus; createdAt: Date; resolvedAt?: Date | null };

interface ReportCommentView {
  id: string;
  body: string;
  mentions: WallMention[];
  projectRefs: WallProjectRef[];
  author: WallAuthor | null;
  createdAt: string;
  status: WallCommentStatus;
}

export interface WallReportView {
  id: string;
  reason: string;
  note: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  /** How many open reports this comment has, this one included. */
  openCount: number;
  reporter: WallAuthor | null;
  wallAccountName: string;
  comment: ReportCommentView | null;
}

export interface WallReportGroupView {
  /** The comment's id (it stays even once the comment is gone). */
  commentId: string;
  wallAccountName: string;
  comment: ReportCommentView | null;
  /** The comment it answers, for context; null for a top-level comment. */
  parent: ReportCommentView | null;
  reports: WallReportView[];
  openCount: number;
  latestAt: string;
  /** The author's record: comments removed after reports in the last 30 days, and any restriction. */
  authorActionedCount: number;
  authorRestrictedUntil: string | null;
}

async function requireModerator(viewerId: string): Promise<void> {
  if (!(await isModerator(viewerId))) throw new WallError('forbidden');
}

/** Views of reports and their comments (with tags resolved for `viewerId`). */
async function reportViews(viewerId: string, reports: LeanReport[], withParents = false) {
  const commentIds = [...new Set(reports.map(r => r.commentId.toString()))];
  const comments = await WallComment.find({ _id: { $in: commentIds } }).lean<LeanComment[]>();
  const parents = withParents
    ? await WallComment.find({ _id: { $in: comments.map(c => c.replyToId ?? c.parentId).filter(Boolean) } }).lean<LeanComment[]>()
    : [];
  const userIds = [...new Set([
    ...reports.map(r => r.reporterId.toString()),
    ...reports.map(r => r.wallUserId.toString()),
    ...[...comments, ...parents].map(c => c.authorId.toString()),
  ])];
  const [users, openCounts, resolved] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('accountName displayName avatarUrl role').lean<LeanUser[]>(),
    WallCommentReport.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { commentId: { $in: commentIds.map(oid) }, status: 'open' } },
      { $group: { _id: '$commentId', n: { $sum: 1 } } },
    ]),
    resolveTags([...comments, ...parents].map(c => c.body), viewerId),
  ]);
  const userById = new Map(users.map(u => [u._id.toString(), u]));
  const commentById = new Map([...comments, ...parents].map(c => [c._id.toString(), c]));
  const openCountOf = new Map(openCounts.map(o => [o._id.toString(), o.n]));
  const person = (id: string) => { const u = userById.get(id); return u ? authorView(u, true) : null; };
  const commentView = (c: LeanComment | undefined): ReportCommentView | null => c ? {
    id: c._id.toString(), body: c.body, ...tagsOf(c.body, resolved), author: person(c.authorId.toString()),
    createdAt: c.createdAt.toISOString(), status: c.status ?? 'visible',
  } : null;
  const view = (r: LeanReport): WallReportView => ({
    id: r._id.toString(),
    reason: r.reason,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    openCount: openCountOf.get(r.commentId.toString()) ?? 0,
    reporter: person(r.reporterId.toString()),
    wallAccountName: userById.get(r.wallUserId.toString())?.accountName ?? '',
    comment: commentView(commentById.get(r.commentId.toString())),
  });
  const parentOf = (commentId: string) => {
    const c = commentById.get(commentId);
    const pid = c ? (c.replyToId ?? c.parentId)?.toString() : null;
    return pid ? commentView(commentById.get(pid)) : null;
  };
  return { view, parentOf, commentById };
}

/** Reports for moderators (users.ban), oldest open first. */
export async function listReports(viewerId: string, status: ReportStatus = 'open', limit = 50): Promise<WallReportView[]> {
  await requireModerator(viewerId);
  const reports = await WallCommentReport.find({ status }).sort({ createdAt: status === 'open' ? 1 : -1 }).limit(Math.min(100, Math.max(1, limit))).lean<LeanReport[]>();
  const { view } = await reportViews(viewerId, reports);
  return reports.map(view);
}

/**
 * Reports for moderators, one entry per comment: every report on it with that status, the
 * comment it answers, and its author's record. Open ones oldest first, settled ones newest first.
 */
export async function listReportGroups(viewerId: string, status: ReportStatus = 'open', limit = 30): Promise<WallReportGroupView[]> {
  await requireModerator(viewerId);
  const latest = await WallCommentReport.aggregate<{ _id: mongoose.Types.ObjectId; at: Date }>([
    { $match: { status } },
    { $group: { _id: '$commentId', at: { $max: status === 'open' ? '$createdAt' : { $ifNull: ['$resolvedAt', '$createdAt'] } } } },
    { $sort: { at: status === 'open' ? 1 : -1 } },
    { $limit: Math.min(100, Math.max(1, limit)) },
  ]);
  const reports = await WallCommentReport.find({ commentId: { $in: latest.map(l => l._id) }, status }).sort({ createdAt: 1 }).lean<LeanReport[]>();
  const { view, parentOf, commentById } = await reportViews(viewerId, reports, true);

  const authorIds = [...new Set([
    ...[...commentById.values()].map(c => c.authorId.toString()),
    ...reports.flatMap(r => r.authorId ? [r.authorId.toString()] : []),
  ])];
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const [actioned, restrictions] = await Promise.all([
    // Distinct comments of theirs removed after a report (reports keep the author's id).
    WallCommentReport.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
      { $match: { status: 'actioned', resolvedAt: { $gte: since }, authorId: { $in: authorIds.map(oid) } } },
      { $group: { _id: '$authorId', n: { $addToSet: '$commentId' } } },
      { $project: { n: { $size: '$n' } } },
    ]),
    WallRestriction.find({ userId: { $in: authorIds.map(oid) } }).lean(),
  ]);
  const actionedOf = new Map(actioned.map(a => [a._id.toString(), a.n]));
  const restrictionOf = new Map(restrictions
    .filter(r => !r.until || r.until.getTime() > Date.now())
    .map(r => [r.userId.toString(), r.until?.toISOString() ?? 'forever']));

  const byComment = new Map<string, WallReportView[]>();
  for (const r of reports) {
    const key = r.commentId.toString();
    byComment.set(key, [...(byComment.get(key) ?? []), view(r)]);
  }
  return latest.filter(l => byComment.has(l._id.toString())).map(l => {
    const key = l._id.toString();
    const group = byComment.get(key)!;
    const authorId = commentById.get(key)?.authorId.toString() ?? reports.find(r => r.commentId.toString() === key && r.authorId)?.authorId?.toString() ?? null;
    return {
      commentId: key,
      wallAccountName: group[0].wallAccountName,
      comment: group[0].comment,
      parent: parentOf(key),
      reports: group,
      openCount: group[0].openCount,
      latestAt: l.at.toISOString(),
      authorActionedCount: authorId ? actionedOf.get(authorId) ?? 0 : 0,
      authorRestrictedUntil: authorId ? restrictionOf.get(authorId) ?? null : null,
    };
  });
}

/** The viewer's own reports, newest first, with what became of each. */
export async function listMyReports(viewerId: string, limit = 50, offset = 0): Promise<{ reports: WallReportView[]; total: number }> {
  const filter = { reporterId: oid(viewerId) };
  const [reports, total] = await Promise.all([
    WallCommentReport.find(filter).sort({ createdAt: -1 }).skip(Math.max(0, offset)).limit(Math.min(100, Math.max(1, limit))).lean<LeanReport[]>(),
    WallCommentReport.countDocuments(filter),
  ]);
  const { view } = await reportViews(viewerId, reports);
  // A reporter learns the outcome, not how many others reported it.
  return { reports: reports.map(r => ({ ...view(r), openCount: 0 })), total };
}

/**
 * Settles a report. 'delete' removes the comment (and with it every open report on it);
 * 'dismiss' closes this comment's open reports without touching it. Each reporter is told,
 * and the decision goes in the audit log.
 */
export async function resolveReport(viewerId: string, reportId: string, action: 'dismiss' | 'delete', ip?: string | null): Promise<boolean> {
  await requireModerator(viewerId);
  const report = mongoose.isValidObjectId(reportId) ? await WallCommentReport.findById(reportId).lean<LeanReport>() : null;
  if (!report) throw new WallError('not_found');
  const settled = await WallCommentReport.find({ commentId: report.commentId, status: 'open' }).select('_id reporterId').lean<LeanReport[]>();
  const comment = await WallComment.findById(report.commentId).select('authorId body').lean<LeanComment>();
  const outcome = action === 'delete' ? 'actioned' : 'dismissed';
  if (action === 'delete') {
    await deleteComment(viewerId, report.commentId.toString());
  }
  // Already-deleted comment: still close its reports.
  await WallCommentReport.updateMany(
    { commentId: report.commentId, status: 'open' },
    { $set: { status: outcome, resolvedBy: oid(viewerId), resolvedAt: new Date() } },
  );

  const [wallOwner, author] = await Promise.all([
    User.findById(report.wallUserId).select('accountName').lean<LeanUser>(),
    comment ? User.findById(comment.authorId).select('accountName').lean<LeanUser>() : null,
  ]);
  for (const r of settled) {
    notifyWallReportReviewed({
      recipientId: r.reporterId.toString(), reportId: r._id.toString(), outcome, wallOwnerAccountName: wallOwner?.accountName ?? '',
    }).catch(() => {});
  }
  await logAdminAction({
    adminId: viewerId,
    action: action === 'delete' ? 'wall_report_delete' : 'wall_report_dismiss',
    targetId: comment?.authorId.toString() ?? null,
    targetName: author?.accountName ?? null,
    details: `${settled.length} report(s) on ${wallOwner?.accountName ?? '?'}'s wall${comment ? `: ${comment.body.slice(0, 200)}` : ''}`,
    ip,
  }).catch(() => {});
  emitReportQueue().catch(() => {});
  return true;
}

// ─── Commenting restrictions (wall.restrict) ────────────────────────────────

async function requireRestrictor(viewerId: string): Promise<LeanUser> {
  const viewer = await User.findById(viewerId).select('permissions accountName').lean<LeanUser>();
  if (!viewer || !hasPermission(viewer.permissions, 'wall.restrict')) throw new WallError('forbidden');
  return viewer;
}

/** Hours a restriction can be set for; null is "until lifted". */
export const RESTRICTION_HOURS = [1, 24, 24 * 7, 24 * 30] as const;

/**
 * Stops `userId` from commenting on any wall for `hours` (null: until lifted). Staff are
 * protected from it like from bans: only someone of higher rank may restrict them.
 */
export async function restrictCommenter(viewerId: string, userId: string, hours: number | null, rawReason: string | null | undefined, ip?: string | null): Promise<string | null> {
  const viewer = await requireRestrictor(viewerId);
  if (!mongoose.isValidObjectId(userId) || userId === viewerId) throw new WallError('forbidden');
  if (hours !== null && !(RESTRICTION_HOURS as readonly number[]).includes(hours)) throw new WallError('invalid_body');
  const target = await User.findById(userId).select('accountName role').lean<LeanUser>();
  if (!target) throw new WallError('not_found');
  const me = await User.findById(viewerId).select('role').lean<LeanUser>();
  if (rankOf(target.role) >= rankOf(me?.role) && rankOf(target.role) > 0) throw new WallError('forbidden');
  const until = hours === null ? null : new Date(Date.now() + hours * 60 * 60_000);
  const reason = stripHtml(rawReason ?? '').trim().slice(0, 300);
  await WallRestriction.updateOne(
    { userId: oid(userId) },
    { $set: { until, reason, createdBy: oid(viewerId), createdAt: new Date() } },
    { upsert: true, timestamps: false },
  );
  notifyWallRestricted({ recipientId: userId, until, reason }).catch(() => {});
  await logAdminAction({
    adminId: viewerId, adminName: viewer.accountName, action: 'wall_restrict', targetId: userId, targetName: target.accountName ?? null,
    details: `${until ? `Until ${until.toISOString()}` : 'Until lifted'}${reason ? ` — ${reason}` : ''}`, ip,
  }).catch(() => {});
  return until?.toISOString() ?? 'forever';
}

/** Lifts `userId`'s commenting restriction. */
export async function liftRestriction(viewerId: string, userId: string, ip?: string | null): Promise<boolean> {
  const viewer = await requireRestrictor(viewerId);
  if (!mongoose.isValidObjectId(userId)) throw new WallError('not_found');
  const removed = await WallRestriction.deleteOne({ userId: oid(userId) });
  if (removed.deletedCount) {
    const target = await User.findById(userId).select('accountName').lean<LeanUser>();
    await logAdminAction({
      adminId: viewerId, adminName: viewer.accountName, action: 'wall_unrestrict', targetId: userId, targetName: target?.accountName ?? null, ip,
    }).catch(() => {});
  }
  return true;
}

/** Tells everyone watching `ownerId`'s wall that something changed; they refetch what they need. */
type WallEvent =
  | { type: 'comment'; commentId: string; parentId: string | null }
  | { type: 'edit'; commentId: string }
  | { type: 'delete'; commentId: string }
  | { type: 'like'; commentId: string; likeCount: number }
  | { type: 'pin'; commentId: string | null }
  | { type: 'reaction'; commentId: string }
  // Who may see what changed (approved, hidden, removed in bulk): watchers reload their page.
  | { type: 'reload' };

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
