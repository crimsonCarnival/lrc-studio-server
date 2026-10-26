import mongoose from 'mongoose';
import { isValidReaction, REACTION_MAX_LENGTH } from './reaction.emoji.js';

export interface IReaction {
  userId: mongoose.Types.ObjectId;
  targetType: 'project';
  targetId: string;
  /** A quick-reaction code ('heart', 'fire', ...) or one emoji. */
  emoji: string;
  createdAt: Date;
}

const reactionSchema = new mongoose.Schema<IReaction>(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['project'], required: true },
    targetId:   { type: String, required: true },
    // Second line of defence behind the service check: the same rule, at the DB layer.
    emoji:      { type: String, required: true, maxlength: REACTION_MAX_LENGTH, validate: isValidReaction },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'reactions' }
);

reactionSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });
reactionSchema.index({ targetType: 1, targetId: 1 });

export default mongoose.model<IReaction>('Reaction', reactionSchema);
