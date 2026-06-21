import mongoose from 'mongoose';

export interface IBlock {
  blockerId: mongoose.Types.ObjectId;
  blockedId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const blockSchema = new mongoose.Schema<IBlock>(
  {
    blockerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'blocks' }
);

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
// Reverse lookup: "who blocked me" (for symmetric discovery filtering).
blockSchema.index({ blockedId: 1 });

export default mongoose.model<IBlock>('Block', blockSchema);
