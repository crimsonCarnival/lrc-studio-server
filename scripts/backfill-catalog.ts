/**
 * Turns the artists and albums already on users' projects into PENDING global-catalog
 * requests, so staff review them through the normal queue.
 *
 * DRY RUN BY DEFAULT: it only reports. Nothing is created without --write.
 * Idempotent: any catalog entry with the same key, in ANY status (a rejection too), is skipped.
 *
 *   pnpm tsx scripts/backfill-catalog.ts                        # artists, report only
 *   pnpm tsx scripts/backfill-catalog.ts --report out.json      # also save the full report
 *   pnpm tsx scripts/backfill-catalog.ts --write                # create the pending artist requests
 *   pnpm tsx scripts/backfill-catalog.ts --phase albums --write # after staff approved the artists
 *
 * Flags (defaults in brackets):
 *   --phase artists|albums   which catalog entries to request [artists]. Albums need an
 *                            APPROVED catalog artist and use the project's primary artist.
 *   --min-songs N            candidate must appear on >= N projects [2]
 *   --limit N                max entries created per run, most projects first [25]
 *   --per-user N             max new entries per submitter per run [1]
 *   --write                  actually create entries (without it: dry run)
 *   --report <file>          save the full JSON report
 *
 * The submitter is the user with the most projects for that candidate (verified, not deleted,
 * not banned, with room under their pending cap), so approval credits a real contributor.
 * Entries are inserted directly: no CatalogSubmissionLog rows, so nobody's daily allowance is used.
 */
import 'dotenv/config';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { runBackfill, BACKFILL_DEFAULTS, type BackfillPhase } from '../src/modules/catalog/catalog.backfill.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const intFlag = (name: string, fallback: number): number => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`❌  ${name} must be a positive integer (got "${raw}").`);
    process.exit(1);
  }
  return n;
};

const WRITE = args.includes('--write');
const phase = (flag('--phase') ?? BACKFILL_DEFAULTS.phase) as BackfillPhase;
if (phase !== 'artists' && phase !== 'albums') {
  console.error('❌  --phase must be "artists" or "albums".');
  process.exit(1);
}
const REPORT_PATH = flag('--report');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  const host = mongoose.connection.host;
  console.log(`✅  Connected to MongoDB host ${host}${WRITE ? '  (WRITE MODE)' : '  (DRY RUN — no writes; pass --write to create)'}`);
  const report = await runBackfill({
    phase,
    write: WRITE,
    minSongs: intFlag('--min-songs', BACKFILL_DEFAULTS.minSongs),
    limit: intFlag('--limit', BACKFILL_DEFAULTS.limit),
    perUser: intFlag('--per-user', BACKFILL_DEFAULTS.perUser),
    log: (m) => console.log(m),
  });

  console.log(`\nSummary (${WRITE ? 'written' : 'DRY RUN'}):`, report.summary);
  const planned = report.rows.filter((r) => r.status === 'create');
  console.log(`\n── ${WRITE ? 'created' : 'would create'} (${planned.length}) ──`);
  for (const r of planned) {
    const parent = r.artistName ? ` by "${r.artistName}"` : '';
    console.log(`${r.kind} "${r.name}"${parent}  projects=${r.projectCount} users=${r.userCount} submitter=${r.chosenSubmitterId}`);
  }
  for (const status of ['error', 'parent_not_approved', 'per_user_limit', 'over_limit', 'no_eligible_submitter'] as const) {
    const rows = report.rows.filter((r) => r.status === status);
    if (rows.length) console.log(`\n${status}: ${rows.length} (see --report for the rows)`);
  }
  if (REPORT_PATH) {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${REPORT_PATH}`);
  }
  if (report.summary.error > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('❌  Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
