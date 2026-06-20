import mongoose from 'mongoose';

export interface IBoost {
  userId: mongoose.Types.ObjectId;
  publicId: string;
  createdAt: Date;
}

const boostSchema = new mongoose.Schema<IBoost>(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publicId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'boosts' }
);

boostSchema.index({ userId: 1, publicId: 1 }, { unique: true });
boostSchema.index({ publicId: 1 });

export default mongoose.model<IBoost>('Boost', boostSchema);
