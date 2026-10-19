import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import { generateUniqueAccountName } from './account-name.service.js';

export interface BackfillOptions {
  batchSize?: number;
  /** Count what would change without writing. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  /** Rows that collided on the unique index and could not be named after retries. */
  failed: number;
}

/**
 * Fills `User.accountName` for every account that lacks one, in batches by
 * `_id`. Registration now requires a name and Google sign-up generates one, so
 * this only has to reach accounts created before that rule — but it must reach
 * all of them: `/:accountName` is the profile URL and project URLs are scoped
 * under it, so an unnamed owner makes `projectPath()` throw.
 *
 * Idempotent: it selects only rows with no name, so a re-run after a full pass
 * changes nothing. Names come from `generateUniqueAccountName`, the same
 * generator Google sign-up uses, so backfilled and live names cannot drift.
 * Writes bypass timestamps so the migration does not bump every user's
 * `updatedAt`.
 */
export async function backfillAccountNames(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const { batchSize = 500, dryRun = false, log = () => undefined } = opts;
  const result: BackfillResult = { scanned: 0, updated: 0, failed: 0 };

  const needsName = { $or: [{ accountName: { $exists: false } }, { accountName: null }, { accountName: '' }] };
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: Record<string, unknown> = lastId ? { $and: [needsName, { _id: { $gt: lastId } }] } : needsName;
    const rows = await User.find(filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('displayName email')
      .lean<{ _id: mongoose.Types.ObjectId; displayName?: string | null; email?: string | null }[]>();
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]._id;
    result.scanned += rows.length;

    for (const row of rows) {
      // Email local part is the best hint when there is no display name.
      const hint = row.displayName || row.email?.split('@')[0] || '';
      let named = false;
      // One candidate can lose a race with a concurrent signup between the
      // generator's uniqueness check and the write; the unique index is the
      // real guard, so retry on its duplicate-key error.
      for (let attempt = 0; attempt < 3 && !named; attempt++) {
        const accountName = await generateUniqueAccountName(hint);
        if (dryRun) {
          log(`accountNames: would set ${row._id} -> ${accountName}`);
          named = true;
          break;
        }
        try {
          await User.collection.updateOne({ _id: row._id }, { $set: { accountName } });
          named = true;
        } catch (e) {
          if ((e as { code?: number }).code !== 11000) throw e;
        }
      }
      if (named) result.updated += 1;
      else result.failed += 1;
    }

    log(`accountNames: scanned ${result.scanned}, updated ${result.updated}`);
  }

  if (result.failed) log(`accountNames: ${result.failed} account(s) could not be named — re-run`);
  return result;
}
