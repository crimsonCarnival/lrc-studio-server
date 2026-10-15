import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import AccountNameHistory from '../../db/account-name-history.model.js';

const norm = (name: string): string => name.toLowerCase().trim();

/**
 * Resolves an account name taken from a URL to its owner. A current account
 * name always wins; only when nobody holds it now is the name looked up in the
 * rename history (newest row first), so an old link follows the user to their
 * new name. Callers compare the returned `accountName` with the one requested
 * and redirect when they differ.
 */
export async function findUserByAccountName<T = Record<string, unknown>>(
  accountName: string,
  select?: string,
): Promise<(T & { _id: mongoose.Types.ObjectId; accountName?: string }) | null> {
  const name = norm(accountName);
  type Row = T & { _id: mongoose.Types.ObjectId; accountName?: string };

  const current = await User.findOne({ accountName: name }).select(select ?? '').lean<Row>();
  if (current) return current;

  const past = await AccountNameHistory.findOne({ from: name }).sort({ createdAt: -1 }).lean<{ userId: mongoose.Types.ObjectId }>();
  if (!past) return null;
  return User.findById(past.userId).select(select ?? '').lean<Row>();
}

/**
 * True when `name` is a former name of a user other than `userId`. Old names are
 * never handed out again: reuse would silently repoint every old link at a
 * different person.
 */
export async function isAccountNameInHistoryOfOther(name: string, userId?: string | mongoose.Types.ObjectId | null): Promise<boolean> {
  const filter: Record<string, unknown> = { from: norm(name) };
  if (userId) filter.userId = { $ne: new mongoose.Types.ObjectId(String(userId)) };
  return !!(await AccountNameHistory.exists(filter));
}

/**
 * Records that `userId` moved from `from` to `to`. Names the user is switching
 * back to are released from their own history first, so the history never lists
 * a name the user currently holds.
 */
export async function recordAccountNameChange(
  userId: mongoose.Types.ObjectId,
  from: string,
  to: string,
): Promise<void> {
  await AccountNameHistory.deleteMany({ userId, from: norm(to) });
  await AccountNameHistory.create({ userId, from: norm(from), to: norm(to) });
}
