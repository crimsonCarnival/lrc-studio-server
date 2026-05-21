import mongoose, { type Document, type Model } from 'mongoose';

export interface IEmailVerification extends Document {
  userId: mongoose.Types.ObjectId;
  email: string;
  type: 'initial' | 'email_change';
  tokenHash: string;
  expiresAt: Date;
  isUsed: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const emailVerificationSchema = new mongoose.Schema<IEmailVerification>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true, lowercase: true },
    type: { type: String, enum: ['initial', 'email_change'], required: true },
    tokenHash: { type: String, required: true, index: true, unique: true },
    expiresAt: { type: Date, required: true },
    isUsed: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'email_verifications' }
);

emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
emailVerificationSchema.index({ userId: 1, type: 1 });

const EmailVerification: Model<IEmailVerification> = mongoose.model('EmailVerification', emailVerificationSchema);
export default EmailVerification;
