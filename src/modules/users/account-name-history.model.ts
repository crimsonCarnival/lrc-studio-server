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
// Old-name lookup (profile redirects and the "never reuse" check). Deliberately
// not unique: rows written before this lookup existed can repeat a name (a name
// freed by one user's rename and later taken and renamed away by another), and a
// unique build over that data would fail. Uniqueness of a *claimed* name is
// enforced in account-name.service instead.
accountNameHistorySchema.index({ from: 1, createdAt: -1 });

const AccountNameHistory: Model<IAccountNameHistory> = mongoose.model('AccountNameHistory', accountNameHistorySchema);
export default AccountNameHistory;
