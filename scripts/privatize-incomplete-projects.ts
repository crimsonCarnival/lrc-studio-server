/**
 * One-off: make public projects with untimed lyric lines (or no lyric lines)
 * private. Fully timed public projects stay public.
 *
 * DRY RUN BY DEFAULT: lists the projects and the count, writes and sends nothing.
 * Review that list before applying.
 *
 *   pnpm tsx scripts/privatize-incomplete-projects.ts            # dry run
 *   pnpm tsx scripts/privatize-incomplete-projects.ts --apply    # writes
 *
 * Idempotent (a second --apply changes 0). Sends one notification per owner.
 * No socket server runs here, so viewers already in a project room are not
 * evicted; reads are denied by the server as soon as the project is private.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { privatizeIncomplete } from '../src/modules/projects/privatize-incomplete.service.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${APPLY ? '' : '  (DRY RUN — no writes, no notifications; pass --apply to write)'}`);
  const { matched, changed } = await privatizeIncomplete({ dryRun: !APPLY, log: (m) => console.log(m) });
  for (const m of matched) console.log(`   ${m.publicId}  "${m.title}"  ${m.timed}/${m.total} timed`);
  console.log(APPLY
    ? `\n✅  Made ${changed} of ${matched.length} matched project(s) private`
    : `\n📋  Would make ${matched.length} project(s) private`);
}

main()
  .catch((err) => {
    console.error('❌  Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
