import mongoose from 'mongoose';

const NOTIFICATION_TYPES = [
  'star', 'fork',
  'follow',
  'reaction',
  'admin_granted',
  'system', 'admin',
  'verify_email', 'set_password',
  'ban', 'password_changed',
  'badge_awarded',
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
    projectId:    { type: String, default: null },
    projectTitle: { type: String, default: null },
    actors:       { type: [actorSchema], default: [] },
    actorCount:   { type: Number, default: 0 },
    body:         { type: String, default: null },
  },
  { timestamps: true, collection: 'notifications' }
);

// List + badge count
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

// One aggregated notification per {userId, type, projectId} for star/fork/reaction
notificationSchema.index(
  { userId: 1, type: 1, projectId: 1 },
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

export interface INotification {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  type: NotificationType;
  read: boolean;
  sticky: boolean;
  projectId: string | null;
  projectTitle: string | null;
  actors: Array<{
    userId: mongoose.Types.ObjectId;
    accountName: string;
    avatarUrl: string | null;
  }>;
  actorCount: number;
  body: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export default mongoose.model('Notification', notificationSchema);
