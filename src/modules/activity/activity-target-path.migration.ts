import mongoose from 'mongoose';
import Activity from '../../db/activity.model.js';
import Project from '../projects/project.model.js';
import User from '../../db/user.model.js';
import { projectPath } from '../../utils/project-slug.js';

export interface BackfillOptions {
  /** Count what would change without writing. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  /** Rows whose project or owner no longer resolves — nothing to point at. */
  skipped: number;
}

/** The activity types that address a project; the rest set their own path at write time. */
const PROJECT_TYPES = ['project_published', 'project_starred', 'project_forked', 'project_boosted'] as const;

/**
 * Fills `Activity.targetPath` for project activities written before the resolvers
 * started setting it.
 *
 * The feed needs this because it cannot derive the path itself: for starred,
 * forked and boosted rows the actor is *not* the project's owner, and an Activity
 * carries no owner account name or slug — so without a stored path those cards
 * render unlinked.
 *
 * Idempotent: only rows with an empty `targetPath` are selected, so a re-run after
 * a full pass changes nothing. Activities have a 365-day TTL, so this is a
 * one-time correction that ages out on its own.
 */
export async function backfillActivityTargetPaths(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const { dryRun = false, log = () => undefined } = opts;
  const result: BackfillResult = { scanned: 0, updated: 0, skipped: 0 };

  const rows = await Activity.find({
    type: { $in: PROJECT_TYPES },
    publicId: { $nin: ['', null] },
    $or: [{ targetPath: '' }, { targetPath: null }, { targetPath: { $exists: false } }],
  }).select('publicId type').lean<{ _id: mongoose.Types.ObjectId; publicId: string; type: string }[]>();

  result.scanned = rows.length;

  // One lookup per distinct project rather than per activity: several rows
  // (a publish plus its stars) commonly point at the same project.
  const paths = new Map<string, string | null>();

  for (const row of rows) {
    if (!paths.has(row.publicId)) {
      paths.set(row.publicId, await resolvePath(row.publicId));
    }
    const targetPath = paths.get(row.publicId) ?? null;

    if (!targetPath) {
      result.skipped += 1;
      log(`activityTargetPath: skipping ${row.type} for ${row.publicId} — project or owner no longer resolves`);
      continue;
    }
    if (dryRun) {
      log(`activityTargetPath: would set ${row.type} for ${row.publicId} -> ${targetPath}`);
      result.updated += 1;
      continue;
    }
    await Activity.collection.updateOne({ _id: row._id }, { $set: { targetPath } });
    result.updated += 1;
  }

  log(`activityTargetPath: scanned ${result.scanned}, updated ${result.updated}, skipped ${result.skipped}`);
  return result;
}

/** The canonical path for a project, or null when it or its owner is gone. */
async function resolvePath(publicId: string): Promise<string | null> {
  const project = await Project.findOne({ publicId })
    .select('publicId slug title metadata userId')
    .lean<{ publicId: string; slug?: string; title?: string; metadata?: object; userId?: unknown } | null>();
  if (!project?.userId) return null;

  const owner = await User.findById(project.userId)
    .select('accountName')
    .lean<{ accountName?: string } | null>();
  if (!owner?.accountName) return null;

  return projectPath(project, owner.accountName);
}
