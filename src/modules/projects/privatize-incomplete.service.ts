import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import { notifyProjectsPrivatized } from '../notifications/notifications.service.js';

export type PrivatizeMatch = { publicId: string; title: string; timed: number; total: number };
export type PrivatizeResult = { matched: PrivatizeMatch[]; changed: number; skippedChanged: number };

export type PrivatizeOptions = {
  dryRun: boolean;
  /**
   * Removes non-owners from the project's Socket.IO room. Optional because a
   * standalone script has no running Socket.IO server; without it, viewers
   * already in a room keep receiving pushes until they disconnect (restart the
   * server after --apply), but every read is denied once `public` is false.
   */
  evictNonOwners?: (publicId: string, ownerId: string | null) => Promise<void>;
  log?: (message: string) => void;
  /** Test seam: runs between the scan and the write of each project. */
  beforeWrite?: (publicId: string) => Promise<void>;
};

export type ParsedArgs = { ok: true; apply: boolean } | { ok: false; error: string };

export const PRIVATIZE_USAGE = 'Usage: privatize-incomplete-projects.ts [--apply]   (no flag = dry run)';

/** Dry run is the default; `--dry-run` is accepted but may not be combined with `--apply`. */
export function parseArgs(argv: string[]): ParsedArgs {
  const unknown = argv.filter((a) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length) return { ok: false, error: `Unknown argument(s): ${unknown.join(' ')}` };
  if (argv.includes('--apply') && argv.includes('--dry-run')) return { ok: false, error: '--apply and --dry-run cannot be combined' };
  return { ok: true, apply: argv.includes('--apply') };
}

/** `host/database` of a Mongo URI with any credentials and query string removed. */
export function describeMongoTarget(uri: string): string {
  const noScheme = uri.replace(/^[a-z+]+:\/\//i, '').replace(/^[^/]*@/, '');
  const slash = noScheme.indexOf('/');
  const host = slash === -1 ? noScheme : noScheme.slice(0, slash);
  const db = slash === -1 ? '' : noScheme.slice(slash + 1).split('?')[0];
  return `${host}/${db || '(default db)'}`;
}

type LyricsLines = { sections?: { lines?: { type?: string; timestamp?: number | null; words?: { time?: number | null }[] | null }[] }[] } | null;

/** Section markers are not lyric lines; a timestamp of 0 is timed; a word time also counts. */
function countLines(lyrics: LyricsLines): { timed: number; total: number } {
  let timed = 0;
  let total = 0;
  for (const section of lyrics?.sections ?? []) {
    for (const line of section.lines ?? []) {
      if (line.type === 'section') continue;
      total++;
      if (line.timestamp != null || (line.words ?? []).some((w) => w?.time != null)) timed++;
    }
  }
  return { timed, total };
}

/**
 * Makes public projects with any untimed lyric line (or no lyric lines at all)
 * private. Fully timed projects are left alone. Idempotent: matching requires
 * `public: true`, so a second run finds nothing.
 *
 * A line is timed if it has a timestamp or any timed word (as in sync-stats);
 * an endTime alone does not count. Section markers never count.
 *
 * Race safety: the scan records each project's `contentUpdatedAt` and the
 * lyrics `version`/`updatedAt` (a lyric save bumps all three). The write only
 * happens if they are unchanged (the project update is conditional on
 * `contentUpdatedAt`, atomically); otherwise the project is skipped and counted
 * in `skippedChanged`.
 *
 * `updatedAt`, `contentUpdatedAt` and `firstPublishedAt` are not touched
 * (visibility is not an edit). One `system` notification per owner, sent right
 * after that owner's projects are written; owner-less (guest) projects are
 * privatized but notify nobody. A notification failure is logged, not fatal.
 */
export async function privatizeIncomplete(options: PrivatizeOptions): Promise<PrivatizeResult> {
  const { dryRun, evictNonOwners, log, beforeWrite } = options;
  const matched: PrivatizeMatch[] = [];
  let changed = 0;
  let skippedChanged = 0;

  type Candidate = { publicId: string; ownerId: string | null; contentUpdatedAt: Date | null; lyricsStamp: string };
  const candidates: Candidate[] = [];
  const stampOf = (l: { version?: number; updatedAt?: Date } | null): string => l ? `${l.version ?? ''}|${l.updatedAt?.getTime() ?? ''}` : 'none';

  const cursor = Project.find({ public: true }).select('publicId title userId contentUpdatedAt').lean().cursor();
  for await (const project of cursor) {
    const lyrics = await Lyrics.findOne({ publicId: project.publicId }).select('sections version updatedAt').lean<LyricsLines & { version?: number; updatedAt?: Date }>();
    const { timed, total } = countLines(lyrics);
    if (total > 0 && timed === total) continue;
    matched.push({ publicId: project.publicId, title: project.title ?? '', timed, total });
    candidates.push({
      publicId: project.publicId,
      ownerId: project.userId ? project.userId.toString() : null,
      contentUpdatedAt: project.contentUpdatedAt ?? null,
      lyricsStamp: stampOf(lyrics),
    });
  }
  if (dryRun) return { matched, changed: 0, skippedChanged: 0 };

  // Group by owner so each owner is notified as soon as their projects are written.
  const byOwner = new Map<string | null, Candidate[]>();
  for (const c of candidates) byOwner.set(c.ownerId, [...(byOwner.get(c.ownerId) ?? []), c]);

  const counts: Record<string, number> = {};
  for (const [ownerId, list] of byOwner) {
    let ownerChanged = 0;
    for (const c of list) {
      if (beforeWrite) await beforeWrite(c.publicId);
      const now = await Lyrics.findOne({ publicId: c.publicId }).select('version updatedAt').lean<{ version?: number; updatedAt?: Date } | null>();
      if (stampOf(now) !== c.lyricsStamp) { skippedChanged++; continue; }

      const res = await Project.updateOne(
        { publicId: c.publicId, public: true, contentUpdatedAt: c.contentUpdatedAt ?? { $in: [null] } },
        { $set: { public: false } },
        { timestamps: false },
      );
      if (res.modifiedCount === 0) {
        if (await Project.exists({ publicId: c.publicId, public: true })) skippedChanged++;
        continue;
      }
      ownerChanged++;
      if (evictNonOwners) {
        try { await evictNonOwners(c.publicId, ownerId); } catch { /* best effort */ }
      }
    }
    changed += ownerChanged;
    if (!ownerId || ownerChanged === 0) continue;
    counts[ownerId] = ownerChanged;
    try {
      await notifyProjectsPrivatized(ownerId, ownerChanged);
    } catch (err) {
      log?.(`notification failed for ${ownerId}: ${(err as Error).message}`);
    }
  }
  log?.(`owner -> privatized count (for recovery): ${JSON.stringify(counts)}`);
  return { matched, changed, skippedChanged };
}
