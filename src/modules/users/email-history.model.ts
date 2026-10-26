import mongoose, { type Document, type Model } from 'mongoose';

export interface IEmailHistory extends Document {
  userId: mongoose.Types.ObjectId;
  from: string;
  to: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const emailHistorySchema = new mongoose.Schema<IEmailHistory>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: String, required: true, lowercase: true },
    to: { type: String, required: true, lowercase: true },
  },
  { timestamps: true, collection: 'email_history' }
);

emailHistorySchema.index({ userId: 1, createdAt: -1 });

const EmailHistory: Model<IEmailHistory> = mongoose.model('EmailHistory', emailHistorySchema);
export default EmailHistory;
