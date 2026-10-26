import mongoose, { type Document, type Model } from 'mongoose';

export interface IPasswordReset extends Document {
  email: string;
  tokenHash: string;
  expiresAt: Date;
  isUsed: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const passwordResetSchema = new mongoose.Schema<IPasswordReset>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      index: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    isUsed: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index: auto-delete documents 0 seconds after expiresAt (immediate expiry)
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for rate limiting queries
passwordResetSchema.index({ email: 1, createdAt: 1 });

const PasswordReset: Model<IPasswordReset> = mongoose.model('PasswordReset', passwordResetSchema);

export default PasswordReset;
