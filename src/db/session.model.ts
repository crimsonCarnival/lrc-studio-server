import mongoose, { type Document, type Model } from 'mongoose';

export interface ISession extends Document {
  userId: mongoose.Types.ObjectId;
  refreshTokenHash: string;
  familyId: string;
  isValid: boolean;
  expiresAt: Date;
  ip: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
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
      required: true,
    },
    deviceId: {
      type: String,
      required: true,
    },
  },
  { timestamps: true, collection: 'sessions' }
);

export default mongoose.model<ISession, ISessionModel>('Session', sessionSchema);
