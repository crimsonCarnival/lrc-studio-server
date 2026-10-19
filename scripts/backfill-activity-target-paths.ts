/**
 * One-off: fill `Activity.targetPath` for project activities written before the
 * resolvers started setting it.
 *
 * The feed cannot derive the path itself — for starred/forked/boosted rows the
 * actor is not the project's owner, and an Activity carries no owner account
 * name or slug — so those cards render unlinked without a stored path.
 * Idempotent: only rows with an empty path are touched, so it is safe to re-run.
 *
 *   pnpm tsx scripts/backfill-activity-target-paths.ts
 *   pnpm tsx scripts/backfill-activity-target-paths.ts --dry-run
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillActivityTargetPaths } from '../src/modules/activity/activity-target-path.migration.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  const result = await backfillActivityTargetPaths({ dryRun: DRY_RUN, log: (m) => console.log(m) });
  console.log('Done:', result);
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
