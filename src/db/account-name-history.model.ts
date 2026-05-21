import mongoose, { type Document, type Model } from 'mongoose';

export interface IAccountNameHistory extends Document {
  userId: mongoose.Types.ObjectId;
  from: string;
  to: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const accountNameHistorySchema = new mongoose.Schema<IAccountNameHistory>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
  },
  { timestamps: true, collection: 'account_name_history' }
);

accountNameHistorySchema.index({ userId: 1, createdAt: -1 });

const AccountNameHistory: Model<IAccountNameHistory> = mongoose.model('AccountNameHistory', accountNameHistorySchema);
export default AccountNameHistory;
