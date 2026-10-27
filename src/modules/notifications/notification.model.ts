import mongoose from 'mongoose';

const NOTIFICATION_TYPES = [
  'star', 'fork',
  'follow',
  'reaction',
  'admin_granted',
  'system', 'admin',
  'verify_email', 'set_password',
  'ban', 'unban', 'password_changed',
  'badge_awarded',
  'request_submitted', 'request_reviewed',
  'xp_changed', 'role_changed',
  'streak_warning',
  'followed_project',
  'wall_comment',
  'mention',
  'comment_like',
  'level_up',
  'playlist_saved',
  'star_milestone',
  'new_device',
  'appeal_result',
  'wall_report', 'wall_report_reviewed', 'wall_restricted',
  'report', 'report_reviewed',
] as const;

export type NotificationType = typeof NOTIFICATION_TYPES[number];

const actorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    accountName: { type: String, required: true },
    avatarUrl: { type: String, default: null },
  },
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:         { type: String, enum: NOTIFICATION_TYPES, required: true },
    read:         { type: Boolean, default: false },
    sticky:       { type: Boolean, default: false },
    publicId:    { type: String, default: null },
    projectTitle: { type: String, default: null },
    actors:       { type: [actorSchema], default: [] },
    actorCount:   { type: Number, default: 0 },
    body:         { type: String, default: null },
    // Structured payload for notifications that render before -> after changes
    // (xp_changed: { delta, before, after }; role_changed: { from, to };
    // streak_warning: { current, day }).
    meta:         { type: mongoose.Schema.Types.Mixed, default: null },
    // Set by notifications.events' deliver() for notifications that fold repeat events into
    // one unread row; the unique index below makes concurrent folds land on the same row.
    dedupeKey:    { type: String },
  },
  { timestamps: true, collection: 'notifications' }
);

// List + badge count
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

// One aggregated notification per {userId, type, publicId} for star/fork/reaction
notificationSchema.index(
  { userId: 1, type: 1, publicId: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['star', 'fork', 'reaction'] } } }
);

// One sticky notification per user per type
notificationSchema.index(
  { userId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['verify_email', 'set_password'] } } }
);

// One aggregated follow notification per user
notificationSchema.index(
  { userId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'follow' }, name: 'unique_follow_per_user' }
);

// One unread folded notification per recipient and event key (wall comments, followed
// projects, playlist saves, …). Without it two concurrent upserts both insert. Rows
// written before dedupeKey existed have none and are left out of the index.
notificationSchema.index(
  { userId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { read: false, dedupeKey: { $exists: true } }, name: 'unique_unread_dedupe_key' }
);

export interface INotification {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  type: NotificationType;
  read: boolean;
  sticky: boolean;
  publicId: string | null;
  projectTitle: string | null;
  actors: Array<{
    userId: mongoose.Types.ObjectId;
    accountName: string;
    avatarUrl: string | null;
  }>;
  actorCount: number;
  body: string | null;
  meta: Record<string, unknown> | null;
  dedupeKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export default mongoose.model('Notification', notificationSchema);
