/**
 * Converts legacy `metadata.songArtist` strings into structured `metadata.artists`
 * (primary / featured credits), moving a title's or song name's "feat." segment
 * into `artists` and recomputing the slug.
 *
 * DRY RUN BY DEFAULT: it only reports. Nothing is written without --write.
 * Idempotent: converted projects are skipped on a re-run.
 *
 *   pnpm tsx scripts/migrate-artists.ts                       # report only
 *   pnpm tsx scripts/migrate-artists.ts --report out.json     # also save the full report
 *   pnpm tsx scripts/migrate-artists.ts --write               # apply the unambiguous rows
 *   pnpm tsx scripts/migrate-artists.ts --write --include-ambiguous
 *
 * "Ambiguous" = split on `&` / `and` / `x` (could be one act, e.g. Simon & Garfunkel)
 * or a bare `ft` / `feat`. Those are listed in the report and skipped unless
 * --include-ambiguous is given. Malformed rows (empty marker, unbalanced
 * bracket, too many names…) are never applied.
 */
import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { migrateArtists } from '../src/modules/artists/artist-migration.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const INCLUDE_AMBIGUOUS = args.includes('--include-ambiguous');
const reportIdx = args.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 ? args[reportIdx + 1] : undefined;

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${WRITE ? '' : '  (DRY RUN — no writes; pass --write to apply)'}`);
  const report = await migrateArtists({ write: WRITE, includeAmbiguous: INCLUDE_AMBIGUOUS, log: (m) => console.log(m) });

  const { entries, ...summary } = report;
  console.log('\nSummary:', summary);
  for (const status of ['apply', 'ambiguous', 'invalid'] as const) {
    const rows = entries.filter((e) => e.status === status);
    if (!rows.length) continue;
    console.log(`\n── ${status} (${rows.length}, first 25) ──`);
    for (const e of rows.slice(0, 25)) {
      console.log(`${e.publicId}  "${e.before.songArtist}" | "${e.before.songName || e.before.title}"`);
      if (e.after) console.log(`    → ${e.after.artists.join(', ')}  | title "${e.after.title}" song "${e.after.songName}"`);
      if (e.reason) console.log(`    ! ${e.reason}`);
      if (e.flags.length) console.log(`    flags: ${e.flags.map((f) => f.code).join(', ')}`);
    }
  }
  if (REPORT_PATH) {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${REPORT_PATH}`);
  }
}

main()
  .catch((err) => {
    console.error('❌  Migration failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
