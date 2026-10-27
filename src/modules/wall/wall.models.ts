import mongoose from 'mongoose';

/** The deepest a comment can sit: a comment (0), a reply to it (1), a reply to that reply (2). */
export const WALL_MAX_DEPTH = 2;
export const WALL_MAX_LENGTH = 500;

export interface IWallComment {
  wallUserId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  parentId: mongoose.Types.ObjectId | null;
  /** Set on a reply to a comment already at the deepest level: the reply sits beside it
   *  (same parent) and is listed right after it. */
  replyToId?: mongoose.Types.ObjectId | null;
  depth: number;
  body: string;
  createdAt: Date;
  /** When the author last edited it; edits are allowed for a short while after posting. */
  editedAt?: Date | null;
  /** When the wall's owner pinned it (top-level only, one per wall). */
  pinnedAt?: Date | null;
  /**
   * visible: shown to everyone. pending: held for the owner's approval (only the owner, its
   * author and moderators see it). hidden: hidden by the owner or a moderator (same audience).
   */
  status?: WallCommentStatus;
  /** Why a pending comment was held. */
  heldReason?: 'approval' | 'muted_word' | null;
  /** Earlier bodies, oldest first: one entry per edit. */
  revisions?: { body: string; editedAt: Date }[];
}

export const WALL_COMMENT_STATUSES = ['visible', 'pending', 'hidden'] as const;
export type WallCommentStatus = (typeof WALL_COMMENT_STATUSES)[number];

const wallCommentSchema = new mongoose.Schema<IWallComment>(
  {
    wallUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', default: null },
    replyToId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', default: null },
    depth: { type: Number, required: true, min: 0, max: WALL_MAX_DEPTH, default: 0 },
    body: { type: String, required: true, trim: true, maxlength: WALL_MAX_LENGTH },
    editedAt: { type: Date, default: null },
    pinnedAt: { type: Date, default: null },
    status: { type: String, enum: WALL_COMMENT_STATUSES, default: 'visible' },
    heldReason: { type: String, enum: ['approval', 'muted_word', null], default: null },
    revisions: { type: [{ _id: false, body: String, editedAt: Date }], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_comments' },
);

// Top-level comments of one wall, newest first; and the replies under a given comment.
wallCommentSchema.index({ wallUserId: 1, parentId: 1, createdAt: -1 });
wallCommentSchema.index({ parentId: 1 }, { sparse: true });

export const WallComment = mongoose.model<IWallComment>('WallComment', wallCommentSchema);

/** One person's like on one comment; the count is derived from these rows, never stored. */
export interface IWallCommentLike {
  commentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const wallCommentLikeSchema = new mongoose.Schema<IWallCommentLike>(
  {
    commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_comment_likes' },
);

wallCommentLikeSchema.index({ commentId: 1, userId: 1 }, { unique: true });

export const WallCommentLike = mongoose.model<IWallCommentLike>('WallCommentLike', wallCommentLikeSchema);

export const WALL_REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'other'] as const;
export type WallReportReason = (typeof WALL_REPORT_REASONS)[number];

/** One person's report of one comment, waiting for (or settled by) a moderator. */
export interface IWallCommentReport {
  commentId: mongoose.Types.ObjectId;
  wallUserId: mongoose.Types.ObjectId;
  reporterId: mongoose.Types.ObjectId;
  /** Who wrote the reported comment; kept so their record survives the comment's removal. */
  authorId?: mongoose.Types.ObjectId | null;
  reason: WallReportReason;
  note: string;
  status: 'open' | 'dismissed' | 'actioned';
  resolvedBy?: mongoose.Types.ObjectId | null;
  resolvedAt?: Date | null;
  createdAt: Date;
}

const wallCommentReportSchema = new mongoose.Schema<IWallCommentReport>(
  {
    commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', required: true },
    wallUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, enum: WALL_REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: 300 },
    status: { type: String, enum: ['open', 'dismissed', 'actioned'], default: 'open', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_comment_reports' },
);

// One report per person per comment; reporting again just updates it.
wallCommentReportSchema.index({ commentId: 1, reporterId: 1 }, { unique: true });
// A reporter's own history, newest first.
wallCommentReportSchema.index({ reporterId: 1, createdAt: -1 });

export const WallCommentReport = mongoose.model<IWallCommentReport>('WallCommentReport', wallCommentReportSchema);

export interface IWallSubscription {
  wallUserId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const wallSubscriptionSchema = new mongoose.Schema<IWallSubscription>(
  {
    wallUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_subscriptions' },
);

wallSubscriptionSchema.index({ wallUserId: 1, userId: 1 }, { unique: true });
wallSubscriptionSchema.index({ userId: 1 });

export const WallSubscription = mongoose.model<IWallSubscription>('WallSubscription', wallSubscriptionSchema);

/** One person's emoji reaction on one comment; a person may react with several emoji. */
export interface IWallCommentReaction {
  commentId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  /** A quick-reaction code or a single emoji (see reactions/reaction.emoji.ts). */
  emoji: string;
  createdAt: Date;
}

const wallCommentReactionSchema = new mongoose.Schema<IWallCommentReaction>(
  {
    commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    emoji: { type: String, required: true, maxlength: 32 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_comment_reactions' },
);

wallCommentReactionSchema.index({ commentId: 1, userId: 1, emoji: 1 }, { unique: true });

export const WallCommentReaction = mongoose.model<IWallCommentReaction>('WallCommentReaction', wallCommentReactionSchema);

/** Someone who stopped hearing about replies in one thread (keyed by its top-level comment). */
export interface IWallThreadMute {
  userId: mongoose.Types.ObjectId;
  rootId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const wallThreadMuteSchema = new mongoose.Schema<IWallThreadMute>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rootId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_thread_mutes' },
);

wallThreadMuteSchema.index({ userId: 1, rootId: 1 }, { unique: true });
wallThreadMuteSchema.index({ rootId: 1 });

export const WallThreadMute = mongoose.model<IWallThreadMute>('WallThreadMute', wallThreadMuteSchema);

/**
 * A moderator stopped someone from commenting on any wall, until `until` (null: until lifted).
 * Set and lifted by staff with wall.restrict; one row per person, the latest decision wins.
 */
export interface IWallRestriction {
  userId: mongoose.Types.ObjectId;
  until: Date | null;
  reason: string;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
}

const wallRestrictionSchema = new mongoose.Schema<IWallRestriction>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    until: { type: Date, default: null },
    reason: { type: String, default: '', maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_restrictions' },
);

export const WallRestriction = mongoose.model<IWallRestriction>('WallRestriction', wallRestrictionSchema);
