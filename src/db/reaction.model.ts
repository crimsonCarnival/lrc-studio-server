import mongoose from 'mongoose';

const ALLOWED_EMOJIS = ['heart', 'fire', 'wow', 'laugh', 'clap', 'music'] as const;
export type EmojiCode = typeof ALLOWED_EMOJIS[number];

export interface IReaction {
  userId: mongoose.Types.ObjectId;
  targetType: 'project';
  targetId: string;
  emoji: EmojiCode;
  createdAt: Date;
}

const reactionSchema = new mongoose.Schema<IReaction>(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['project'], required: true },
    targetId:   { type: String, required: true },
    emoji:      { type: String, enum: ALLOWED_EMOJIS, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'reactions' }
);

reactionSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });
reactionSchema.index({ targetType: 1, targetId: 1 });

export { ALLOWED_EMOJIS };
export default mongoose.model<IReaction>('Reaction', reactionSchema);
