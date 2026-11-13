import Project from './project.model.js';

// "No cover" = missing, null or ''. Everything else is a cover.
const NO_COVER = { $in: [null, ''] };
const HAS_COVER = { $nin: [null, ''] };

export type HasCoverBackfill = { toSetTrue: number; toSetFalse: number };

/**
 * Brings Project.hasCover in line with coverImage. Idempotent: only documents
 * whose flag is wrong are touched, so a second run reports zeros. With apply=false
 * it only counts. Uses the native collection so updatedAt is not bumped (a
 * derived flag is not a user edit) and the pre-update hook is not involved.
 */
export async function backfillHasCover(apply: boolean): Promise<HasCoverBackfill> {
  const needsTrue = { coverImage: HAS_COVER, hasCover: { $ne: true } };
  const needsFalse = { coverImage: NO_COVER, hasCover: { $ne: false } };

  if (!apply) {
    const [toSetTrue, toSetFalse] = await Promise.all([
      Project.collection.countDocuments(needsTrue),
      Project.collection.countDocuments(needsFalse),
    ]);
    return { toSetTrue, toSetFalse };
  }

  const [t, f] = await Promise.all([
    Project.collection.updateMany(needsTrue, { $set: { hasCover: true } }),
    Project.collection.updateMany(needsFalse, { $set: { hasCover: false } }),
  ]);
  return { toSetTrue: t.modifiedCount, toSetFalse: f.modifiedCount };
}
