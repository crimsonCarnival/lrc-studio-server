import mongoose from 'mongoose';

export const REPORT_TARGET_TYPES = ['wall_comment', 'user', 'project', 'playlist'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'impersonation', 'copyright', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The reasons offered for each kind of target; anything else is refused. */
export const REASONS_BY_TYPE: Record<ReportTargetType, readonly ReportReason[]> = {
  wall_comment: ['spam', 'harassment', 'hate', 'sexual', 'other'],
  user: ['spam', 'harassment', 'hate', 'sexual', 'impersonation', 'other'],
  project: ['spam', 'hate', 'sexual', 'copyright', 'other'],
  playlist: ['spam', 'hate', 'sexual', 'copyright', 'other'],
};

export const REPORT_STATUSES = ['open', 'dismissed', 'actioned'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_NOTE_MAX = 300;

/** One person's report of one thing (a wall comment, an account, a project, a playlist). */
export interface IReport {
  targetType: ReportTargetType;
  /** The comment's, user's, project's or playlist's _id; it stays once the target is gone. */
  targetId: mongoose.Types.ObjectId;
  /**
   * Who is accountable for the target: the comment's author, the reported user, the project's
   * or playlist's owner. Kept so their record survives the target's removal.
   */
  subjectUserId: mongoose.Types.ObjectId | null;
  /** The wall's owner for a wall comment; null otherwise. */
  contextUserId: mongoose.Types.ObjectId | null;
  reporterId: mongoose.Types.ObjectId;
  reason: ReportReason;
  note: string;
  status: ReportStatus;
  resolvedBy: mongoose.Types.ObjectId | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

const reportSchema = new mongoose.Schema<IReport>(
  {
    targetType: { type: String, enum: REPORT_TARGET_TYPES, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    contextUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    note: { type: String, default: '', maxlength: REPORT_NOTE_MAX },
    status: { type: String, enum: REPORT_STATUSES, default: 'open' },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'reports' },
);

// One report per person per target; reporting again updates (and reopens) it.
reportSchema.index({ targetType: 1, targetId: 1, reporterId: 1 }, { unique: true });
// A reporter's own history, newest first (and the per-reporter rate limit).
reportSchema.index({ reporterId: 1, createdAt: -1 });
// The moderators' queue, per status and optionally per type.
reportSchema.index({ status: 1, targetType: 1, createdAt: 1 });
// A subject's record: what of theirs was actioned lately.
reportSchema.index({ subjectUserId: 1, status: 1, resolvedAt: -1 });

export const Report = mongoose.model<IReport>('Report', reportSchema);
