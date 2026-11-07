/**
 * One-off: make public projects with untimed lyric lines (or no lyric lines)
 * private. Fully timed public projects stay public. A line counts as timed if
 * it has a timestamp or any timed word.
 *
 * DRY RUN BY DEFAULT: lists the projects and the count, writes and sends nothing.
 * Review that list before applying.
 *
 *   pnpm tsx scripts/privatize-incomplete-projects.ts            # dry run
 *   pnpm tsx scripts/privatize-incomplete-projects.ts --apply    # writes
 *
 * Idempotent (a second --apply changes 0). Projects whose lyrics/content changed
 * between the scan and the write are skipped (reported as skippedChanged).
 * Sends one notification per owner. Failure policy: a project that cannot be
 * read or written, or an owner whose notice cannot be stored, is listed in the
 * final summary and the script exits 1. A failed notice cannot be resent by a
 * rerun (the projects are no longer public), so notify those owners manually
 * from the printed owner-to-count list. A dry run that could not read some
 * projects is a lower bound and also exits 1.
 *
 * What it does NOT handle (runs in its own process, no Socket.IO server):
 * - Live push: owners online now will see the notice after reconnect or a
 *   server restart (the row is persisted; the live server's heap and sockets
 *   are not touched).
 * - Viewers already in a project's socket room keep receiving pushes until they
 *   disconnect. Restart the server after --apply. Reads are denied at once.
 * - Playlists containing the project: not edited. Non-owners stop seeing it
 *   (playlist reads filter to public-or-own); the owner still sees it.
 * - `public_project_count` badge: checked at grant time only; already-granted
 *   badges are not revoked by this script.
 * - Addiction-level `publicProjects`: computed from live project flags, so it
 *   drops on the next read.
 * - Trending score: stale until the hourly job; explore queries filter on
 *   `public`, so the project leaves discovery immediately.
 * - OG image cache: any cached image stays until it expires.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import {
  privatizeIncomplete,
  parseArgs,
  describeMongoTarget,
  PRIVATIZE_USAGE,
  errorText,
  checkTarget,
} from '../src/modules/projects/privatize-incomplete.service.js';

const args = parseArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(`❌  ${args.error}\n${PRIVATIZE_USAGE}`);
  process.exit(1);
}
const APPLY = args.apply;

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

async function main(): Promise<void> {
  const target = describeMongoTarget(MONGO_URI);
  console.log(`🎯  Target: ${target}  (${APPLY ? 'APPLY' : 'DRY RUN — no writes, no notifications; pass --apply to write'})`);
  const gate = checkTarget(APPLY, target);
  if (gate.warning) console.error(gate.warning);
  if (!gate.proceed) {
    process.exitCode = 1;
    return;
  }
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');
  const { matched, changed, skippedChanged, failed, notifyFailed } = await privatizeIncomplete({ dryRun: !APPLY, log: (m) => console.log(m) });
  for (const m of matched) console.log(`   ${m.publicId}  "${m.title}"  ${m.timed}/${m.total} timed`);
  if (APPLY) {
    console.log(`
✅  Made ${changed} of ${matched.length} matched project(s) private; ${skippedChanged} skipped (changed during the run)`);
    console.log('ℹ️   Owners online now will see the notice after reconnect or a server restart. Restart the server to drop viewers already in project rooms.');
  } else {
    console.log(`
📋  Would make ${matched.length} project(s) private (target above)`);
  }
  if (failed.length) {
    for (const f of failed) console.error(`   could not process ${f.publicId}: ${f.error}`);
    console.error(APPLY
      ? `❌  ${failed.length} project(s) failed (listed above); exiting non-zero`
      : `❌  ${failed.length} project(s) could not be read; the list above is a lower bound. Exiting non-zero`);
    process.exitCode = 1;
  }
  if (notifyFailed.length) {
    console.error('❌  Notices could not be stored for these owners (ownerId: projects privatized). Notify them manually:');
    for (const n of notifyFailed) console.error(`   ${n.ownerId}: ${n.count}  (${n.error})`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`❌  Failed: ${e.name}: ${errorText(e, MONGO_URI)}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
