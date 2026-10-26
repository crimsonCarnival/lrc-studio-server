import mongoose, { type Document, type Model } from 'mongoose';

export interface ISession extends Document {
  userId: mongoose.Types.ObjectId;
  refreshTokenHash: string;
  familyId: string;
  isValid: boolean;
  expiresAt: Date;
  ip: string;
  deviceId: string;
  userAgent: string;
  deviceName: string;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  previousRefreshTokenHash?: string;
  previousRefreshTokenExpiry?: Date;
}

export interface ISessionModel extends Model<ISession> {}

const sessionSchema = new mongoose.Schema<ISession>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    refreshTokenHash: {
      type: String,
      required: true,
    },
    familyId: {
      type: String,
      required: true,
      index: true,
    },
    isValid: {
      type: Boolean,
      default: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // Automatically delete document when expiresAt is reached
    },
    ip: {
      type: String,
      default: 'unknown',
    },
    deviceId: {
      type: String,
      default: 'unknown',
    },
    userAgent: {
      type: String,
      default: '',
    },
    deviceName: {
      type: String,
      default: 'Unknown Device',
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
    previousRefreshTokenHash: {
      type: String,
      default: null,
    },
    previousRefreshTokenExpiry: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, collection: 'sessions' }
);

export default mongoose.model<ISession, ISessionModel>('Session', sessionSchema);
