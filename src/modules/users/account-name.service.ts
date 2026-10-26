import mongoose from 'mongoose';
import User from './user.model.js';
import AccountNameHistory from './account-name-history.model.js';
import { isValidAccountName, isReservedAccountName } from '../auth/auth.validation.js';

const norm = (name: string): string => name.toLowerCase().trim();

/**
 * Reduces an arbitrary display name to the account-name charset. Returns ''
 * when nothing usable survives, so callers can fall back to a generic base.
 */
export function accountNameBase(input: string | null | undefined): string {
  return (input ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    // Leaves room for the `_NNNN` suffix inside the 30-char limit.
    .slice(0, 22);
}

/**
 * Mints an unused account name as `<base>_NNNN`. Used wherever an account is
 * created without the user picking a name (Google sign-up, backfill), so every
 * user satisfies the "every account has an addressable name" invariant.
 *
 * Rejects reserved names and names any user previously held — handing out a
 * former name would silently repoint old links at a different person.
 */
export async function generateUniqueAccountName(
  displayName?: string | null,
  attempts = 25,
): Promise<string> {
  const base = accountNameBase(displayName) || 'user';
  for (let i = 0; i < attempts; i++) {
    const candidate = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
    if (!isValidAccountName(candidate) || isReservedAccountName(candidate)) continue;
    if (await User.exists({ accountName: candidate })) continue;
    if (await isAccountNameInHistoryOfOther(candidate)) continue;
    return candidate;
  }
  // Every random suffix collided — fall back to something that cannot.
  return `user_${new mongoose.Types.ObjectId().toString().slice(-10)}`;
}

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
