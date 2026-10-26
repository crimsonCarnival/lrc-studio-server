import mongoose from 'mongoose';

export interface IFollow {
  followerId: mongoose.Types.ObjectId;
  followingId: mongoose.Types.ObjectId;
  /** What the follower hears about the followed user's projects. Off until they choose. */
  notify: 'off' | 'uploads' | 'all';
  createdAt: Date;
}

const followSchema = new mongoose.Schema<IFollow>(
  {
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    followingId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    notify: { type: String, enum: ['off', 'uploads', 'all'], default: 'off' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'follows' }
);

followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1 });
// Fan-out reads the followers of one user who asked to be told something.
followSchema.index({ followingId: 1, notify: 1 });

export default mongoose.model<IFollow>('Follow', followSchema);
