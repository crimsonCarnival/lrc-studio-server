/**
 * One-off: fill `User.accountName` for every account that lacks one.
 *
 * Registration requires an account name and Google sign-up generates one, so
 * only accounts created before that rule can be unnamed. They must be fixed:
 * `/:accountName` is the profile URL and project URLs are scoped under it, so
 * `projectPath()` throws for an unnamed owner. Idempotent and batched — safe to
 * re-run; named accounts are left alone.
 *
 *   pnpm tsx scripts/backfill-account-names.ts
 *   pnpm tsx scripts/backfill-account-names.ts --dry-run
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillAccountNames } from '../src/modules/users/account-name.migration.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  const result = await backfillAccountNames({ dryRun: DRY_RUN, log: (m) => console.log(m) });
  console.log('Done:', result);
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
