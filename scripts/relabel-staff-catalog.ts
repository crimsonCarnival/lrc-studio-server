/**
 * Relabels catalog artists and albums that STAFF submitted through the community flow
 * (source 'community') to source 'admin', so they read as staff entries and, on approval,
 * stop earning the submitter XP. Entries in ANY status are covered, pending ones included.
 * Staff = holds catalog.manage, or is a superadmin.
 *
 * DRY RUN BY DEFAULT: it only reports. Nothing is changed without --write.
 * Idempotent: only entries still marked 'community' are touched, so a rerun changes nothing.
 * Never run against prod without the owner's OK.
 *
 *   pnpm tsx scripts/relabel-staff-catalog.ts                    # report only
 *   pnpm tsx scripts/relabel-staff-catalog.ts --report out.json  # also save the full report
 *   pnpm tsx scripts/relabel-staff-catalog.ts --write            # relabel
 *
 * Flags:
 *   --write            actually relabel (without it: dry run)
 *   --report <file>    save the full JSON report
 * Values are separate arguments ("--report out.json"); "--flag=value", unknown flags and
 * missing values are rejected before any connection is made.
 *
 * Only `source` changes (updatedAt is kept). creditAwarded, XP and user stats are never touched:
 * entries that already paid out are counted below for information, and no XP is revoked.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { runRelabel } from '../src/modules/catalog/catalog.relabel.js';

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
      report: { type: 'string' },
    },
  }).values;
} catch (err) {
  fail((err as Error).message);
}
// `--report --write` would otherwise swallow the next flag as the value.
for (const [i, a] of argv.entries()) {
  if (a === '--report' && (argv[i + 1] ?? '--').startsWith('--')) fail(`${a} needs a value.`);
}

const WRITE = values.write === true;
const REPORT_PATH = typeof values.report === 'string' ? values.report : undefined;

async function main(): Promise<void> {
  // No autoIndex/autoCreate: even a dry run must not build indexes or collections on the target database.
  await mongoose.connect(MONGO_URI, { autoIndex: false, autoCreate: false });
  const { host, name } = mongoose.connection;
  console.log(`✅  Connected to MongoDB host ${host}, database ${name}${WRITE ? '  (WRITE MODE)' : '  (DRY RUN — no writes; pass --write to relabel)'}`);
  const report = await runRelabel({ write: WRITE, log: (m) => console.log(m) });

  console.log(`\n${WRITE ? 'Relabelled' : 'Would relabel'}: ${report.counts.artist} artists, ${report.counts.album} albums`);
  console.log(`Already credited (informational, no XP is revoked): ${report.creditAwarded.artist} artists, ${report.creditAwarded.album} albums`);
  if (WRITE) console.log(`Documents modified: ${report.modified}`);
  for (const kind of ['artist', 'album'] as const) {
    if (report.ids[kind].length) console.log(`\n${kind} ids:\n  ${report.ids[kind].join('\n  ')}`);
  }
  if (REPORT_PATH) {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nFull report written to ${REPORT_PATH}`);
  }
}

main()
  .catch((err) => {
    console.error('❌  Relabel failed:', err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
