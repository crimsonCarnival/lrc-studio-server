import mongoose from 'mongoose';
import Project from './project.model.js';
import Upload from '../uploads/upload.model.js';
import { projectSlug } from '../../utils/project-slug.js';
import { fallbackTitle, PROJECT_TITLE_MAX } from './project-identity.js';

export interface SlugRow {
  title?: string | null;
  metadata?: { songName?: string | null; songArtist?: string | null } | null;
}

export interface SlugPlan {
  slug: string;
  /** Set only for a row with no identity at all: the title it is given so it satisfies the "nameable" rule. */
  title?: string;
}

/**
 * The slug (and, for nameless legacy rows, a title) one row should end up with.
 * Pure so the fixtures can be tested without a database. It goes through the
 * same `projectSlug` the app uses on every write, so migrated and live values
 * cannot drift.
 */
export function planSlug(row: SlugRow, upload?: { title?: string | null; fileName?: string | null } | null): SlugPlan {
  const slug = projectSlug(row);
  if (slug) return { slug };
  const title = fallbackTitle(upload).slice(0, PROJECT_TITLE_MAX);
  return { slug: projectSlug({ title }), title };
}

export interface BackfillOptions {
  batchSize?: number;
  /** Count what would change without writing. */
  dryRun?: boolean;
  /** Recompute rows that already have a slug too (use after changing the algorithm). */
  recompute?: boolean;
  log?: (message: string) => void;
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  unchanged: number;
  /** Rows that had no title, song name or artist and were given a fallback title. */
  fallbackTitles: number;
}

/**
 * Fills `Project.slug` for every project that lacks one, in batches by `_id`.
 * Idempotent: a filled row is left alone, so a re-run changes nothing. Writes
 * bypass timestamps so a migration does not reorder every user's library by
 * `updatedAt`.
 */
export async function backfillProjectSlugs(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const { batchSize = 500, dryRun = false, recompute = false, log = () => undefined } = opts;
  const result: BackfillResult = { scanned: 0, updated: 0, unchanged: 0, fallbackTitles: 0 };

  const needsSlug = recompute ? {} : { $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] };
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const filter: Record<string, unknown> = lastId ? { $and: [needsSlug, { _id: { $gt: lastId } }] } : needsSlug;
    const rows = await Project.find(filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('title slug metadata.songName metadata.songArtist uploadId')
      .lean<(SlugRow & { _id: mongoose.Types.ObjectId; slug?: string | null; uploadId?: mongoose.Types.ObjectId | null })[]>();
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]._id;
    result.scanned += rows.length;

    // Uploads are only needed for rows with no identity of their own.
    const nameless = rows.filter((r) => !projectSlug(r) && r.uploadId);
    const uploads = nameless.length
      ? await Upload.find({ _id: { $in: nameless.map((r) => r.uploadId) } }).select('title fileName').lean<{ _id: mongoose.Types.ObjectId; title?: string; fileName?: string }[]>()
      : [];
    const uploadById = new Map(uploads.map((u) => [String(u._id), u]));

    const ops: mongoose.AnyBulkWriteOperation[] = [];
    for (const row of rows) {
      const plan = planSlug(row, row.uploadId ? uploadById.get(String(row.uploadId)) : null);
      if (plan.title !== undefined) result.fallbackTitles += 1;
      if (row.slug === plan.slug && plan.title === undefined) {
        result.unchanged += 1;
        continue;
      }
      result.updated += 1;
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: plan.title !== undefined ? { slug: plan.slug, title: plan.title } : { slug: plan.slug } },
        },
      });
    }
    if (ops.length && !dryRun) await Project.bulkWrite(ops, { ordered: false, timestamps: false });
    log(`slugs: scanned ${result.scanned}, updated ${result.updated}`);
  }

  if (result.fallbackTitles) log(`slugs: ${result.fallbackTitles} nameless project(s) were given a fallback title`);
  return result;
}
