import mongoose from 'mongoose';

export const REPORT_MESSAGE_MAX = 1000;

/**
 * One message in a report's conversation between the reporter and the moderators. A reply
 * (parentId set) answers a top-level message; replies don't nest further.
 */
export interface IReportMessage {
  reportId: mongoose.Types.ObjectId;
  authorId: mongoose.Types.ObjectId;
  /** Whether the author was the report's reporter (otherwise a moderator), at writing time. */
  fromReporter: boolean;
  parentId: mongoose.Types.ObjectId | null;
  body: string;
  createdAt: Date;
}

const reportMessageSchema = new mongoose.Schema<IReportMessage>(
  {
    reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report', required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromReporter: { type: Boolean, required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReportMessage', default: null },
    body: { type: String, required: true, trim: true, maxlength: REPORT_MESSAGE_MAX },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'report_messages' },
);

// A report's conversation in order; and an author's recent messages, for the rate limit.
reportMessageSchema.index({ reportId: 1, createdAt: 1 });
reportMessageSchema.index({ authorId: 1, createdAt: -1 });

export const ReportMessage = mongoose.model<IReportMessage>('ReportMessage', reportMessageSchema);
