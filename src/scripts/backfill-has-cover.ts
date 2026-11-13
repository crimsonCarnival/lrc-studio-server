import 'dotenv/config';
import mongoose from 'mongoose';
import { backfillHasCover } from '../modules/projects/has-cover.backfill.js';

// Usage: pnpm exec tsx src/scripts/backfill-has-cover.ts [--apply]
// Without --apply it only reports what would change. Idempotent either way.
async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');

  await mongoose.connect(process.env.MONGODB_URI);
  // Host and database only; the URI carries credentials and is never printed.
  console.log(`Connected to ${mongoose.connection.host} / ${mongoose.connection.name}`);

  const { toSetTrue, toSetFalse } = await backfillHasCover(apply);
  console.log(`${apply ? 'Updated' : 'Would update'}: ${toSetTrue} -> hasCover=true, ${toSetFalse} -> hasCover=false`);
  if (!apply) console.log('Dry run. Re-run with --apply to write.');

  await mongoose.disconnect();
  process.exit(0);
}

run();
