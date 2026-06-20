import mongoose from 'mongoose';

export interface IXPEvent extends Document {
  userId: mongoose.Types.ObjectId;
  type: 'badge_grant' | 'badge_revoke' | 'admin_adjustment' | 'backfill';
  source: string;
  delta: number;
  totalXpAfter: number;
  reason?: string;
  createdAt: Date;
}

const xpEventSchema = new mongoose.Schema<IXPEvent>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ['badge_grant', 'badge_revoke', 'admin_adjustment', 'backfill'], required: true },
    source: { type: String, required: true },
    delta: { type: Number, required: true },
    totalXpAfter: { type: Number, required: true, min: 0 },
    reason: { type: String, default: undefined },
    createdAt: { type: Date, default: () => new Date(), index: true },
  },
  { collection: 'xp_events' }
);

xpEventSchema.index({ userId: 1, createdAt: -1 });
xpEventSchema.index({ type: 1, createdAt: -1 });

export default mongoose.model<IXPEvent>('XPEvent', xpEventSchema);
