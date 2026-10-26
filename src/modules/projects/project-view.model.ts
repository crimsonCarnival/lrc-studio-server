import mongoose from 'mongoose';

/**
 * Dedup ledger for public project view counts: has THIS viewer already been
 * counted for THIS project TODAY? One row per (viewerKey, projectId, day).
 * Checked with an insert-and-swallow-duplicate pattern (unique index) before
 * `Project.viewCount` is incremented, so two simultaneous page loads from the
 * same viewer race safely — only the first insert wins, and only the winner
 * increments the counter.
 *
 * Short-lived: TTL cleans rows up once the day they gate has fully passed.
 * Mirrors `heatmap_project_edits`, which solves the same problem for the
 * activity heatmap.
 */
export interface IProjectView {
  /**
   * Stable identity for the viewer: the User's ObjectId hex for signed-in
   * viewers, or `d:<deviceId>` for anonymous ones. A caller that supplies
   * neither is never written here and never counted — an unkeyable caller
   * cannot be deduplicated.
   */
  viewerKey: string;
  /** Project's publicId (nanoid) — the same external identifier used across the API. */
  projectId: string;
  /** UTC midnight of the counted day. Doubles as the TTL anchor. */
  day: Date;
}

const projectViewSchema = new mongoose.Schema<IProjectView>(
  {
    viewerKey: { type: String, required: true },
    projectId: { type: String, required: true },
    day:       { type: Date, required: true },
  },
  { collection: 'project_views', versionKey: false }
);

// Dedup key: the insert-and-swallow-duplicate check for "already counted today".
projectViewSchema.index({ viewerKey: 1, projectId: 1, day: 1 }, { unique: true });
// ~2 days: outlives the single UTC day it gates with margin, then self-cleans.
// Never read outside that window.
projectViewSchema.index({ day: 1 }, { expireAfterSeconds: 2 * 86400 });

export default mongoose.model<IProjectView>('ProjectView', projectViewSchema);
