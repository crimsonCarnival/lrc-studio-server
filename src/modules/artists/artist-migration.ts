import mongoose from 'mongoose';
import Project from '../projects/project.model.js';
import { projectSlug } from '../../utils/project-slug.js';
import {
  parseArtists, formatArtistDisplay, validateArtistCredits,
  type ArtistCredit, type ParseFlag, type ParseFlagCode,
} from '../../utils/artists.js';
import { linkArtistIds, artistKey, type StoredCredit } from './artist.service.js';

/** Flags a human may knowingly accept with `--include-ambiguous`. Anything else is malformed input and is never applied. */
const OVERRIDABLE: ReadonlySet<ParseFlagCode> = new Set(['ambiguous_separator', 'weak_marker']);

export interface ArtistRow {
  title?: string | null;
  metadata?: { songName?: string | null; songArtist?: string | null; artists?: unknown[] | null } | null;
}

export type PlanStatus = 'apply' | 'ambiguous' | 'invalid' | 'noop';

export interface ArtistPlan {
  status: PlanStatus;
  flags: ParseFlag[];
  reason?: string;
  after?: {
    title: string;
    songName: string;
    songArtist: string;
    artists: ArtistCredit[];
    slug: string;
  };
}

/**
 * What one legacy row should become. Pure, so the fixtures run without a database.
 *
 * - The artist string is parsed for primaries and featured; the song name and the
 *   title are parsed for feat. segments, which are moved into `artists`.
 * - A title / song name is rewritten only when its segment was moved, and never
 *   to an empty string.
 * - Rows that already have `artists` are `noop`, which is what makes a re-run safe.
 * - A row with a doubtful parse is `ambiguous` and left alone unless `includeAmbiguous`.
 */
export function planArtists(row: ArtistRow, includeAmbiguous = false): ArtistPlan {
  const meta = row.metadata ?? {};
  if (Array.isArray(meta.artists) && meta.artists.length > 0) return { status: 'noop', flags: [] };
  const artistText = (meta.songArtist ?? '').trim();
  if (!artistText) return { status: 'noop', flags: [], reason: 'no artist text' };

  const songName = meta.songName ?? '';
  const title = row.title ?? '';
  const fromSong = parseArtists(artistText, songName);
  const fromTitle = parseArtists('', title);
  const flags = [...fromSong.flags, ...fromTitle.flags];

  const credits: ArtistCredit[] = [...fromSong.credits];
  const seen = new Set(credits.map((c) => artistKey(c.name)));
  for (const c of fromTitle.credits) {
    if (seen.has(artistKey(c.name))) continue;
    seen.add(artistKey(c.name));
    credits.push({ name: c.name, role: 'featured', order: credits.length });
  }

  const blocking = flags.filter((f) => f.code !== 'duplicate_removed');
  const malformed = blocking.filter((f) => !OVERRIDABLE.has(f.code));
  if (malformed.length > 0) return { status: 'invalid', flags, reason: `malformed: ${malformed.map((f) => f.code).join(', ')}` };
  if (blocking.length > 0 && !includeAmbiguous) return { status: 'ambiguous', flags };

  const validation = validateArtistCredits(credits.map(({ name, role }) => ({ name, role })));
  if (!validation.ok) return { status: 'invalid', flags, reason: validation.code };

  const newSongName = fromSong.title ?? songName;
  const newTitle = fromTitle.title ?? title;
  const after = {
    title: newTitle.trim() ? newTitle : title,
    songName: newSongName.trim() || !songName ? newSongName : songName,
    songArtist: formatArtistDisplay(validation.credits),
    artists: validation.credits,
    slug: '',
  };
  after.slug = projectSlug({ title: after.title, metadata: { songName: after.songName, songArtist: after.songArtist } });
  return { status: 'apply', flags, after };
}

export interface MigrationOptions {
  /** Without it nothing is written: the report only. */
  write?: boolean;
  includeAmbiguous?: boolean;
  batchSize?: number;
  log?: (message: string) => void;
}

export interface MigrationReportEntry {
  publicId: string;
  status: PlanStatus;
  reason?: string;
  before: { title: string; songName: string; songArtist: string };
  after?: { title: string; songName: string; songArtist: string; artists: string[] };
  flags: { code: ParseFlagCode; text: string }[];
}

export interface MigrationReport {
  dryRun: boolean;
  scanned: number;
  apply: number;
  ambiguous: number;
  invalid: number;
  noop: number;
  /** Rows actually written (always 0 in a dry run). */
  written: number;
  entries: MigrationReportEntry[];
}

type Row = ArtistRow & { _id: mongoose.Types.ObjectId; publicId: string; userId?: mongoose.Types.ObjectId | null };

/**
 * Converts legacy `songArtist` strings into structured `artists`, a batch at a
 * time. Dry run by default. Idempotent: converted rows have `artists`, so a
 * second run scans only what was skipped. Writes bypass timestamps so the
 * library is not reordered by `updatedAt`.
 */
export async function migrateArtists(opts: MigrationOptions = {}): Promise<MigrationReport> {
  const { write = false, includeAmbiguous = false, batchSize = 200, log = () => undefined } = opts;
  const report: MigrationReport = { dryRun: !write, scanned: 0, apply: 0, ambiguous: 0, invalid: 0, noop: 0, written: 0, entries: [] };

  const base = { 'metadata.songArtist': { $nin: ['', null] }, 'metadata.artists.0': { $exists: false } };
  let lastId: mongoose.Types.ObjectId | null = null;
  for (;;) {
    const rows: Row[] = await Project.find(lastId ? { ...base, _id: { $gt: lastId } } : base)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('publicId userId title metadata.songName metadata.songArtist metadata.artists')
      .lean<Row[]>();
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]._id;

    const ops: mongoose.AnyBulkWriteOperation[] = [];
    for (const row of rows) {
      report.scanned += 1;
      const plan = planArtists(row, includeAmbiguous);
      report[plan.status] += 1;
      if (plan.status === 'noop') continue;
      report.entries.push({
        publicId: row.publicId,
        status: plan.status,
        reason: plan.reason,
        before: { title: row.title ?? '', songName: row.metadata?.songName ?? '', songArtist: row.metadata?.songArtist ?? '' },
        after: plan.after && {
          title: plan.after.title, songName: plan.after.songName, songArtist: plan.after.songArtist,
          artists: plan.after.artists.map((a) => `${a.role}:${a.name}`),
        },
        flags: plan.flags.map((f) => ({ code: f.code, text: f.text })),
      });
      if (plan.status !== 'apply' || !plan.after || !write) continue;

      const credits: StoredCredit[] = plan.after.artists.map((a) => ({ ...a }));
      if (row.userId) await linkArtistIds(row.userId, credits);
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              title: plan.after.title,
              'metadata.songName': plan.after.songName,
              'metadata.songArtist': plan.after.songArtist,
              'metadata.artists': credits,
              slug: plan.after.slug,
            },
          },
        },
      });
    }
    if (ops.length) {
      await Project.bulkWrite(ops, { ordered: false, timestamps: false });
      report.written += ops.length;
    }
    log(`artists: scanned ${report.scanned}, apply ${report.apply}, ambiguous ${report.ambiguous}, invalid ${report.invalid}, written ${report.written}`);
  }
  return report;
}
