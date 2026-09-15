import mongoose, { type Document, type Model } from 'mongoose';

export interface IJobLog extends Document {
  jobType: 'extract_lyrics' | 'infer_end_times';
  status: 'succeeded' | 'failed';
  error?: string | null;
  userId?: mongoose.Types.ObjectId | null;
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
  },
  {
    timestamps: true,
    collection: 'job_logs',
  }
);

export default mongoose.model<IJobLog, IJobLogModel>('JobLog', jobLogSchema);
