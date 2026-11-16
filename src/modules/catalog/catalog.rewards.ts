import mongoose from 'mongoose';
import User from '../users/user.model.js';
import { recomputeXP, triggerBadgeCheck } from '../badges/badge.service.js';

const counterOf = (kind: 'artist' | 'album'): string =>
  kind === 'artist' ? 'stats.catalogArtistsApproved' : 'stats.catalogAlbumsApproved';

/**
 * Credits the submitter of an approved community entry: one atomic $inc, then XP (derived from
 * stats, so re-runnable), then a fire-and-forget badge check. Callers guarantee at most one call
 * per entry by flipping `creditAwarded` conditionally first.
 */
export async function awardCatalogCredit(userId: string, kind: 'artist' | 'album'): Promise<void> {
  await User.updateOne({ _id: new mongoose.Types.ObjectId(userId) }, { $inc: { [counterOf(kind)]: 1 } });
  await recomputeXP(userId);
  triggerBadgeCheck(userId, 'catalog_approved').catch((err) => console.error('[catalog] badge check failed', err));
}

/**
 * Inverse of award for abuse deletions. ONE atomic guarded $inc first (only while the counter is
 * above 0, so it can never go negative), then XP is recomputed from stats. Idempotent and safe to
 * re-run: callers log a throw for manual repair and never abort a delete or restore creditAwarded
 * because of it. Badges already granted are kept.
 */
export async function revokeCatalogCredit(userId: string, kind: 'artist' | 'album'): Promise<void> {
  const field = counterOf(kind);
  await User.updateOne({ _id: new mongoose.Types.ObjectId(userId), [field]: { $gt: 0 } }, { $inc: { [field]: -1 } });
  await recomputeXP(userId);
}
