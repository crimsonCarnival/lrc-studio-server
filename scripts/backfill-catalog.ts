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
 *   --phase artists|albums   which catalog entries to request [artists]. Albums need exactly one
 *                            APPROVED catalog artist of that name and use the project's primary artist.
 *   --min-songs N            candidate must appear on >= N projects [2]
 *   --limit N                max entries created per run, most projects first [25]
 *   --per-user N             max new entries per submitter per run [1]
 *   --write                  actually create entries (without it: dry run)
 *   --report <file>          save the full JSON report
 * Values are separate arguments ("--phase albums"); "--phase=albums", unknown flags and missing
 * values are rejected before any connection is made.
 *
 * The submitter is the user with the most projects for that candidate (verified, not deleted,
 * not banned, with room under their pending cap), so approval credits a real contributor.
 * Entries are inserted directly: no CatalogSubmissionLog rows, so nobody's daily allowance is used.
 *
 * Known side effects (owner decisions, not handled here):
 *  - A rejected request still sends the submitter a review notification they never asked for.
 *  - Created entries occupy slots of the submitter's own 5-pending cap until reviewed.
 *  - If a user withdraws a backfilled request, a later run can propose it again.
 *  - Candidates are taken from private projects too, and credited to their owner.
 *  - Approval grants the submitter XP (+125 artist / +250 album) and can trigger badges for an entry they never clicked.
 *  - Reviewers (and the submitter) see the submitter's account name on the entry.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { runBackfill, BACKFILL_DEFAULTS, type BackfillPhase } from '../src/modules/catalog/catalog.backfill.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`❌  ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
// parseArgs accepts `--flag=value`; the contract here is the space form only.
for (const a of argv) if (a.startsWith('--') && a.includes('=')) fail(`"${a}": use "--flag value", not "--flag=value".`);

let values: ReturnType<typeof parseArgs>['values'];
try {
  // strict: unknown flags and flags missing their value throw.
  values = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      write: { type: 'boolean' },
      phase: { type: 'string' },
      'min-songs': { type: 'string' },
      limit: { type: 'string' },
      'per-user': { type: 'string' },
      report: { type: 'string' },
    },
  }).values;
} catch (err) {
  fail((err as Error).message);
}
// `--report --write` would otherwise swallow the next flag as the value.
for (const [i, a] of argv.entries()) {
  if (['--phase', '--min-songs', '--limit', '--per-user', '--report'].includes(a) && (argv[i + 1] ?? '--').startsWith('--')) {
    fail(`${a} needs a value.`);
  }
}

const intFlag = (name: 'min-songs' | 'limit' | 'per-user', fallback: number): number => {
  const v = values[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < 1) fail(`--${name} must be a positive integer (got "${String(v)}").`);
  return Number(v);
};

const WRITE = values.write === true;
const phase = (values.phase ?? BACKFILL_DEFAULTS.phase) as BackfillPhase;
if (phase !== 'artists' && phase !== 'albums') fail('--phase must be "artists" or "albums".');
const OPTIONS = {
  phase,
  write: WRITE,
  minSongs: intFlag('min-songs', BACKFILL_DEFAULTS.minSongs),
  limit: intFlag('limit', BACKFILL_DEFAULTS.limit),
  perUser: intFlag('per-user', BACKFILL_DEFAULTS.perUser),
};
const REPORT_PATH = typeof values.report === 'string' ? values.report : undefined;

async function main(): Promise<void> {
  // No autoIndex/autoCreate: even a dry run must not build indexes or collections on the target database.
  await mongoose.connect(MONGO_URI, { autoIndex: false, autoCreate: false });
  const { host, name } = mongoose.connection;
  console.log(`✅  Connected to MongoDB host ${host}, database ${name}${WRITE ? '  (WRITE MODE)' : '  (DRY RUN — no writes; pass --write to create)'}`);
  const report = await runBackfill({ ...OPTIONS, log: (m) => console.log(m) });

  console.log(`\nSummary (${WRITE ? 'written' : 'DRY RUN'}):`, report.summary);
  const planned = report.rows.filter((r) => r.status === 'create');
  console.log(`\n── ${WRITE ? 'created' : 'would create'} (${planned.length}) ──`);
  for (const r of planned) {
    const parent = r.artistName ? ` by "${r.artistName}"` : '';
    console.log(`${r.kind} "${r.name}"${parent}  projects=${r.projectCount} users=${r.userCount} submitter=${r.chosenSubmitterId}`);
  }
  for (const status of ['error', 'parent_not_approved', 'ambiguous_parent', 'per_user_limit', 'over_limit', 'no_eligible_submitter'] as const) {
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
