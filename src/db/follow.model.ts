import mongoose from 'mongoose';

export interface IFollow {
  followerId: mongoose.Types.ObjectId;
  followingId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const followSchema = new mongoose.Schema<IFollow>(
  {
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'follows' }
);

// Prevent duplicate follows
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
// Efficient "who follows this user" queries
followSchema.index({ followingId: 1 });
// Efficient "who does this user follow" queries
followSchema.index({ followerId: 1 });

export default mongoose.model<IFollow>('Follow', followSchema);
