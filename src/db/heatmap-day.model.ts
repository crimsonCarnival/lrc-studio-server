import mongoose from 'mongoose';

/**
 * Per-user, per-UTC-day counters for private authoring activity (distinct
 * projects created, distinct projects edited with a real content change).
 * Heatmap-only: never read by the social feed, explore, or fan-out, so these
 * events can't leak to followers. One document per (user, day) keeps storage
 * bounded regardless of save volume — each field counts distinct PROJECTS,
 * not raw save events, so ticking autosave on one project all day still only
 * contributes 1. Dedup across saves of the same project on the same day is
 * enforced by `heatmap_project_edits` (see that model) before either field
 * here is incremented.
 */
export interface IHeatmapDay {
  userId: mongoose.Types.ObjectId;
  /** UTC midnight of the counted day. Doubles as the TTL anchor. */
  day: Date;
  projectsCreated: number;
  /** Distinct projects that received a saved content change this day. */
  editedProjects: number;
}

const heatmapDaySchema = new mongoose.Schema<IHeatmapDay>(
  {
    userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day:             { type: Date, required: true },
    projectsCreated: { type: Number, default: 0, min: 0 },
    editedProjects:  { type: Number, default: 0, min: 0 },
  },
  { collection: 'heatmap_days', versionKey: false }
);

// Upsert key + serves the heatmap range query ({ userId, day: { $gte } }).
heatmapDaySchema.index({ userId: 1, day: 1 }, { unique: true });
// ~400 days: outlives the 365-day heatmap window with margin, then self-cleans.
heatmapDaySchema.index({ day: 1 }, { expireAfterSeconds: 400 * 86400 });

export default mongoose.model<IHeatmapDay>('HeatmapDay', heatmapDaySchema);
