import mongoose, { type Document, type Model } from 'mongoose';

/**
 * One row per successful community submission, so the rolling 24h cap survives
 * a withdraw (which deletes the entry). Rows expire on their own after a day.
 */
export interface ICatalogSubmissionLog extends Document {
  userId: mongoose.Types.ObjectId;
  at: Date;
}

const schema = new mongoose.Schema<ICatalogSubmissionLog>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'catalog_submission_log' }
);

schema.index({ at: 1 }, { expireAfterSeconds: 86400 });
schema.index({ userId: 1, at: -1 });

const CatalogSubmissionLog: Model<ICatalogSubmissionLog> = mongoose.model('CatalogSubmissionLog', schema);
export default CatalogSubmissionLog;
