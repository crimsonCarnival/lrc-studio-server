import mongoose from 'mongoose';

/** A user putting someone else's public project on their own profile. Replaces the old Boost. */
export interface IProfileShare {
  userId: mongoose.Types.ObjectId;
  publicId: string;
  /** The sharer's own words about the project. Plain text, rendered escaped. */
  description: string;
  tags: string[];
  createdAt: Date;
}

const profileShareSchema = new mongoose.Schema<IProfileShare>(
  {
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publicId:    { type: String, required: true },
    // Limits are enforced (with a clear error) in normalizeShareNote; these are the backstop.
    description: { type: String, default: '', maxlength: 500 },
    tags:        { type: [String], default: [], validate: { validator: (v: unknown[]) => v.length <= 10 } },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'profile_shares' }
);

profileShareSchema.index({ userId: 1, publicId: 1 }, { unique: true });
// Serves the sharer's profile tab, newest first.
profileShareSchema.index({ userId: 1, createdAt: -1 });
profileShareSchema.index({ publicId: 1 });

export default mongoose.model<IProfileShare>('ProfileShare', profileShareSchema);
