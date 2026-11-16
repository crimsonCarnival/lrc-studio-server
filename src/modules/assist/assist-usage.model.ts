import mongoose from 'mongoose';

/**
 * Per-user, per-UTC-day count of heavy AI-assist runs (romanize + singer labels).
 * One document per (user, day); the unique index is what makes the capped
 * reservation in assist-usage.service atomic.
 */
export type IAssistUsage = {
  userId: mongoose.Types.ObjectId;
  /** UTC midnight of the counted day. Doubles as the TTL anchor. */
  day: Date;
  heavy: number;
};

const assistUsageSchema = new mongoose.Schema<IAssistUsage>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day:    { type: Date, required: true },
    heavy:  { type: Number, default: 0, min: 0 },
  },
  { collection: 'assist_usage', versionKey: false }
);

assistUsageSchema.index({ userId: 1, day: 1 }, { unique: true });
// Old days are never read; keep two days of margin, then self-clean.
assistUsageSchema.index({ day: 1 }, { expireAfterSeconds: 2 * 86400 });

export default mongoose.model<IAssistUsage>('AssistUsage', assistUsageSchema);
