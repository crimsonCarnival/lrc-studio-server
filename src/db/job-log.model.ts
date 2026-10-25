import mongoose, { type Document, type Model } from 'mongoose';

export interface IJobLog extends Document {
  jobType: 'extract_lyrics' | 'infer_end_times';
  status: 'succeeded' | 'failed';
  error?: string | null;
  userId?: mongoose.Types.ObjectId | null;
  /** The song that was looked up (lyrics search only). */
  query?: { track?: string; artist?: string; album?: string } | null;
  /** Which lyrics provider answered. */
  provider?: string | null;
  /** Whether the lyrics that came back carried timestamps. */
  synced?: boolean | null;
  /** Lines returned (search) or processed (infer end times). */
  lineCount?: number | null;
  durationMs?: number | null;
  /** The project the task ran for, when the client said which. */
  publicId?: string | null;
  ip?: string | null;
  deviceId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IJobLogModel extends Model<IJobLog> {}

const jobLogSchema = new mongoose.Schema<IJobLog>(
  {
    jobType: {
      type: String,
      required: true,
      index: true,
      enum: ['extract_lyrics', 'infer_end_times'],
    },
    status: {
      type: String,
      required: true,
      index: true,
      enum: ['succeeded', 'failed'],
    },
    error: {
      type: String,
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    query: {
      type: new mongoose.Schema(
        { track: { type: String, maxlength: 200 }, artist: { type: String, maxlength: 200 }, album: { type: String, maxlength: 200 } },
        { _id: false },
      ),
      default: null,
    },
    provider: { type: String, default: null, maxlength: 40 },
    synced: { type: Boolean, default: null },
    lineCount: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    publicId: { type: String, default: null, maxlength: 40, index: true },
    ip: { type: String, default: null, maxlength: 64 },
    deviceId: { type: String, default: null, maxlength: 128 },
  },
  {
    timestamps: true,
    collection: 'job_logs',
  }
);

// Task records carry the searched song and the caller's address, so they do not outlive their use.
jobLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
jobLogSchema.index({ status: 1, jobType: 1, createdAt: -1 });

export default mongoose.model<IJobLog, IJobLogModel>('JobLog', jobLogSchema);
