import mongoose from 'mongoose';

/** The deepest a comment can sit: a comment (0), a reply to it (1), a reply to that reply (2). */
export const WALL_MAX_DEPTH = 2;
export const WALL_MAX_LENGTH = 500;

export interface IWallComment {
  wallUserId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  parentId: mongoose.Types.ObjectId | null;
  depth: number;
  body: string;
  createdAt: Date;
}

const wallCommentSchema = new mongoose.Schema<IWallComment>(
  {
    wallUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'WallComment', default: null },
    depth: { type: Number, required: true, min: 0, max: WALL_MAX_DEPTH, default: 0 },
    body: { type: String, required: true, trim: true, maxlength: WALL_MAX_LENGTH },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'wall_comments' },
);

// Top-level comments of one wall, newest first; and the replies under a given comment.
wallCommentSchema.index({ wallUserId: 1, parentId: 1, createdAt: -1 });
wallCommentSchema.index({ parentId: 1 }, { sparse: true });

export const WallComment = mongoose.model<IWallComment>('WallComment', wallCommentSchema);

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
