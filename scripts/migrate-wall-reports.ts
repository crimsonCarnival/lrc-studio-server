/**
 * Copy wall_comment_reports into the generic `reports` collection.
 *
 * Idempotent: rows are matched on (wall_comment, commentId, reporterId) and only inserted,
 * never overwritten, so it is safe to re-run. The old collection is NOT dropped. Run once
 * after deploying the generic reports server; until then the moderators' queue only shows
 * reports filed since the deploy.
 *
 *   pnpm tsx scripts/migrate-wall-reports.ts --dry-run
 *   pnpm tsx scripts/migrate-wall-reports.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { copyWallReports } from '../src/modules/reports/migrate-wall-reports.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  const { scanned, inserted, skipped } = await copyWallReports({ dryRun: DRY_RUN });
  console.log(`🔎  ${scanned} wall comment report(s) scanned`);
  console.log(`${DRY_RUN ? '📝  Would insert' : '➕  Inserted'} ${inserted}, already present ${skipped}`);
}

main()
  .catch((err) => {
    console.error('❌  Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
