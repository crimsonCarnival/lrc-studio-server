import mongoose from 'mongoose';
import ProfileShare from './profile-share.model.js';
import Activity from '../activity/activity.model.js';

export interface BoostMigrationOptions {
  /** Count what would change without writing. */
  dryRun?: boolean;
}

export interface BoostMigrationResult {
  /** Rows in the legacy `boosts` collection. */
  scanned: number;
  /** Profile shares inserted (0 on a re-run). */
  inserted: number;
  /** `project_boosted` activities renamed to `project_shared`. */
  activitiesRenamed: number;
}

/**
 * Boost became Share to profile. Copies every `boosts` row into `profile_shares`,
 * keeping its original date, and renames the matching feed activities.
 *
 * Idempotent: shares are upserted on the (userId, publicId) unique key with
 * `$setOnInsert`, and only activities still typed `project_boosted` are renamed, so
 * it runs on every startup and is a no-op once done. The `boosts` collection is
 * read through the raw driver (its model is gone) and is never dropped; drop it by
 * hand once this has run in production.
 */
export async function migrateBoostsToProfileShares(opts: BoostMigrationOptions = {}): Promise<BoostMigrationResult> {
  const { dryRun = false } = opts;
  const boosts = await mongoose.connection.collection('boosts')
    .find({}, { projection: { userId: 1, publicId: 1, createdAt: 1 } })
    .toArray();

  let inserted = 0;
  if (!dryRun && boosts.length > 0) {
    const res = await ProfileShare.collection.bulkWrite(
      boosts.map((b) => ({
        updateOne: {
          filter: { userId: b.userId, publicId: b.publicId },
          update: { $setOnInsert: { userId: b.userId, publicId: b.publicId, createdAt: b.createdAt ?? new Date() } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    inserted = res.upsertedCount;
  }

  const legacy = { type: 'project_boosted' };
  const activitiesRenamed = dryRun
    ? await Activity.collection.countDocuments(legacy)
    : (await Activity.collection.updateMany(legacy, { $set: { type: 'project_shared' } })).modifiedCount;

  return { scanned: boosts.length, inserted, activitiesRenamed };
}
