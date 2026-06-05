import mongoose, { type Document, type Model } from 'mongoose';

export interface IUserActionLog extends Document {
  userId: mongoose.Types.ObjectId | null;
  action: string;
  entityType?: string;
  entityId?: mongoose.Types.ObjectId | string;
  metadata?: Record<string, unknown>;
  ip: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserActionLogModel extends Model<IUserActionLog> {}

const userActionLogSchema = new mongoose.Schema<IUserActionLog>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      default: null, // Allow null for anonymous actions (like failed logins)
    },
    action: {
      type: String,
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      default: null,
    },
    entityId: {
      type: mongoose.Schema.Types.Mixed, // Can be ObjectId or string
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ip: {
      type: String,
      default: 'unknown',
    },
    deviceId: {
      type: String,
      default: 'unknown',
    },
  },
  { 
    timestamps: true,
    collection: 'user_action_logs'
  }
);

// Index for querying by entity
userActionLogSchema.index({ entityType: 1, entityId: 1 });

export default mongoose.model<IUserActionLog, IUserActionLogModel>('UserActionLog', userActionLogSchema);
