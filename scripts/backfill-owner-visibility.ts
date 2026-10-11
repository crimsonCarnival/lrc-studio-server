/**
 * Backfill the denormalized owner-visibility flags on Project and Playlist.
 *
 * `ownerActive`/`ownerListed` default to true on the schema, so every document
 * that existed before this change reads as visible — which is the safe default
 * for the vast majority (active owners) and wrong for exactly the set this
 * change exists to hide. This script sets them correctly for every owner whose
 * state is not "fully visible", and normalises the rest.
 *
 * Idempotent: it recomputes from the user documents rather than toggling, so it
 * is safe to re-run, and safe to run before or after the deploy. Run it once
 * after deploying the model change.
 *
 *   pnpm tsx scripts/backfill-owner-visibility.ts
 *   pnpm tsx scripts/backfill-owner-visibility.ts --dry-run
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../src/db/user.model.js';
import Project from '../src/modules/projects/project.model.js';
import Playlist from '../src/db/playlist.model.js';
import {
  computeOwnerVisibility,
  VISIBLE_OWNER_SELECT,
  type VisibilitySource,
} from '../src/modules/users/owner-visibility.service.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

type OwnerRow = VisibilitySource & { _id: mongoose.Types.ObjectId; accountName?: string };

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`✅  Connected to MongoDB${DRY_RUN ? '  (DRY RUN — no writes)' : ''}`);

  // Only owners who are not fully visible need a targeted update; everything
  // else is already correct at the schema default. They are handled as a single
  // "restore the rest" pass at the end so that re-running repairs drift in
  // either direction.
  const hidden = await User.find({
    $or: [
      { isDeleted: true },
      { 'ban.active': true },
      { 'shadowBan.search': true },
    ],
  })
    .select(`${VISIBLE_OWNER_SELECT} accountName`)
    .lean<OwnerRow[]>();

  console.log(`🔎  ${hidden.length} owner(s) in a non-visible state\n`);

  let projectsChanged = 0;
  let playlistsChanged = 0;

  for (const owner of hidden) {
    const visibility = computeOwnerVisibility(owner);
    const label = owner.accountName ?? owner._id.toString();
    const state = [
      owner.isDeleted ? 'deleted' : null,
      owner.ban?.active ? 'banned' : null,
      owner.shadowBan?.search ? 'shadow-banned' : null,
    ].filter(Boolean).join('+');

    if (DRY_RUN) {
      const [p, l] = await Promise.all([
        Project.countDocuments({ userId: owner._id }),
        Playlist.countDocuments({ userId: owner._id }),
      ]);
      console.log(`   ${label} (${state}) → ${JSON.stringify(visibility)}  ${p} project(s), ${l} playlist(s)`);
      projectsChanged += p;
      playlistsChanged += l;
      continue;
    }

    const [p, l] = await Promise.all([
      Project.updateMany({ userId: owner._id }, { $set: visibility }),
      Playlist.updateMany({ userId: owner._id }, { $set: visibility }),
    ]);
    projectsChanged += p.modifiedCount;
    playlistsChanged += l.modifiedCount;
    console.log(`   ${label} (${state}) → ${JSON.stringify(visibility)}  ${p.modifiedCount} project(s), ${l.modifiedCount} playlist(s)`);
  }

  // Normalise everything else to visible. This is what makes the script
  // idempotent and self-healing: content whose owner was restored, or whose
  // flags drifted because a sync failed mid-write, is corrected here.
  const hiddenIds = hidden.map((o) => o._id);
  if (!DRY_RUN) {
    const visible = { ownerActive: true, ownerListed: true };
    const [p, l] = await Promise.all([
      Project.updateMany(
        { userId: { $nin: hiddenIds }, $or: [{ ownerActive: false }, { ownerListed: false }] },
        { $set: visible },
      ),
      Playlist.updateMany(
        { userId: { $nin: hiddenIds }, $or: [{ ownerActive: false }, { ownerListed: false }] },
        { $set: visible },
      ),
    ]);
    if (p.modifiedCount || l.modifiedCount) {
      console.log(`\n♻️   Restored ${p.modifiedCount} project(s) and ${l.modifiedCount} playlist(s) whose owner is visible again`);
    }
  }

  console.log(`\n${DRY_RUN ? '📋  Would hide' : '✅  Hid'} ${projectsChanged} project(s) and ${playlistsChanged} playlist(s)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌  Backfill failed:', err);
  process.exit(1);
});
