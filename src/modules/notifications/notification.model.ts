import mongoose from 'mongoose';

export type NotificationType =
  | 'star' | 'fork'
  | 'system' | 'admin'
  | 'verify_email' | 'set_password'
  | 'ban' | 'password_changed';

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
    type:         { type: String, enum: ['star','fork','system','admin','verify_email','set_password','ban','password_changed'], required: true },
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

// One aggregated notification per {userId, type, projectId} for star/fork
notificationSchema.index(
  { userId: 1, type: 1, projectId: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['star', 'fork'] } } }
);

// One sticky notification per user per type
notificationSchema.index(
  { userId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['verify_email', 'set_password'] } } }
);

export default mongoose.model('Notification', notificationSchema);
