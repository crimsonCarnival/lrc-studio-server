/**
 * One-off: fill `Project.slug` for every existing project.
 *
 * Idempotent and batched — safe to re-run; filled rows are left alone. Projects
 * with no title, song name or artist get a fallback title (upload title, file
 * name, else "untitled") so they satisfy the "a project must be nameable" rule;
 * the count is logged. Run it after deploying the slug change.
 *
 *   pnpm tsx scripts/backfill-project-slugs.ts
 *   pnpm tsx scripts/backfill-project-slugs.ts --dry-run
 *   pnpm tsx scripts/backfill-project-slugs.ts --recompute   # also rewrite filled rows
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillProjectSlugs } from '../src/modules/projects/project-slug.migration.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const RECOMPUTE = process.argv.includes('--recompute');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);
  const result = await backfillProjectSlugs({ dryRun: DRY_RUN, recompute: RECOMPUTE, log: (m) => console.log(m) });
  console.log('Done:', result);
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
