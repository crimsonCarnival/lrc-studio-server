/**
 * Copy `boosts` into `profile_shares` and rename `project_boosted` activities to
 * `project_shared`.
 *
 * The server already runs this on every startup (plugins/cron.ts), so this script is
 * only for a dry run against a database, or for running it without a deploy. Both are
 * idempotent. The `boosts` collection is NOT dropped.
 *
 *   pnpm tsx scripts/migrate-boosts-to-profile-shares.ts --dry-run
 *   pnpm tsx scripts/migrate-boosts-to-profile-shares.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { migrateBoostsToProfileShares } from '../src/modules/projects/boost-to-profile-share.migration.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  const { scanned, inserted, activitiesRenamed } = await migrateBoostsToProfileShares({ dryRun: DRY_RUN });
  console.log(`🔎  ${scanned} boost(s) scanned`);
  if (!DRY_RUN) console.log(`➕  Inserted ${inserted} profile share(s), ${scanned - inserted} already present`);
  console.log(`${DRY_RUN ? '📝  Would rename' : '✏️  Renamed'} ${activitiesRenamed} activit${activitiesRenamed === 1 ? 'y' : 'ies'}`);
}

main()
  .catch((err) => {
    console.error('❌  Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
