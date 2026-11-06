/**
 * backfill-stats.ts
 *
 * Recomputes user.stats (minutesSynced, secondsSynced, wordsSynced,
 * karaokeLines, syncedLines) for every non-deleted user with the
 * weighted computation used by recomputeSyncStats() (badges/sync-stats.ts), then
 * recomputes XP as a 'backfill' event so the correction stays off the weekly/monthly XP boards.
 * Run it once after deploying the weighted stats.
 *
 * Run with:
 *   npx ts-node --esm scripts/backfill-stats.ts
 *   -- or --
 *   node --loader ts-node/esm scripts/backfill-stats.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/modules/users/user.model.js';
import { recomputeSyncStats, recomputeXP } from '../src/modules/badges/badge.service.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');

  const users = await User.find({ isDeleted: { $ne: true } })
    .select('_id accountName')
    .lean<{ _id: mongoose.Types.ObjectId; accountName?: string }[]>();

  console.log(`🔄  Backfilling stats for ${users.length} users…\n`);

  let ok = 0;
  let failed = 0;

  for (const user of users) {
    const uid = user._id.toString();
    try {
      const stats = await recomputeSyncStats(uid);
      await recomputeXP(uid, 'backfill');
      console.log(
        `  ✓ ${user.accountName ?? uid}` +
        `  syncedLines=${stats.syncedLines}` +
        `  minutesSynced=${stats.minutesSynced}` +
        `  karaokeLines=${stats.karaokeLines}`
      );
      ok++;
    } catch (err) {
      console.error(`  ✗ ${user.accountName ?? uid}:`, (err as Error).message);
      failed++;
    }
  }

  console.log(`\n✅  Done. ${ok} succeeded, ${failed} failed.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
