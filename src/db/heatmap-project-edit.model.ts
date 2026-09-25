import mongoose from 'mongoose';

/**
 * Dedup ledger: has THIS project already contributed to THIS user's heatmap
 * day? One row per (user, project, day). Checked with an insert-and-swallow-
 * duplicate pattern (unique index) before `heatmap_days` is incremented, so
 * concurrent saves/creates of the same project on the same day race safely —
 * only the first insert wins, and only the winner increments the counter.
 * Short-lived: TTL cleans rows up once the day they gate has fully passed.
 */
export interface IHeatmapProjectEdit {
  userId: mongoose.Types.ObjectId;
  /** Project's publicId (nanoid) — the same external identifier used across the API. */
  projectId: string;
  /** UTC midnight of the counted day. Doubles as the TTL anchor. */
  day: Date;
}

const heatmapProjectEditSchema = new mongoose.Schema<IHeatmapProjectEdit>(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: String, required: true },
    day:       { type: Date, required: true },
  },
  { collection: 'heatmap_project_edits', versionKey: false }
);

// Dedup key: the insert-and-swallow-duplicate check for "already counted today".
heatmapProjectEditSchema.index({ userId: 1, projectId: 1, day: 1 }, { unique: true });
// ~2 days: outlives the single UTC day it gates with margin, then self-cleans.
// Never read outside that window, so no need to keep it as long as heatmap_days.
heatmapProjectEditSchema.index({ day: 1 }, { expireAfterSeconds: 2 * 86400 });

export default mongoose.model<IHeatmapProjectEdit>('HeatmapProjectEdit', heatmapProjectEditSchema);
