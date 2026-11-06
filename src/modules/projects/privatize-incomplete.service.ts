import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import { notifyProjectsPrivatized } from '../notifications/notifications.service.js';

export type PrivatizeMatch = { publicId: string; title: string; timed: number; total: number };
export type PrivatizeResult = { matched: PrivatizeMatch[]; changed: number };

export type PrivatizeOptions = {
  dryRun: boolean;
  /**
   * Removes non-owners from the project's Socket.IO room. Optional because a
   * standalone script has no running Socket.IO server; without it, viewers
   * already in a room keep receiving pushes until they disconnect, but every
   * read is denied by the server as soon as `public` is false.
   */
  evictNonOwners?: (publicId: string, ownerId: string | null) => Promise<void>;
  log?: (message: string) => void;
};

type LyricsLines = { sections?: { lines?: { type?: string; timestamp?: number | null }[] }[] } | null;

/** Section markers are not lyric lines; a timestamp of 0 is timed. */
function countLines(lyrics: LyricsLines): { timed: number; total: number } {
  let timed = 0;
  let total = 0;
  for (const section of lyrics?.sections ?? []) {
    for (const line of section.lines ?? []) {
      if (line.type === 'section') continue;
      total++;
      if (line.timestamp != null) timed++;
    }
  }
  return { timed, total };
}

/**
 * Makes public projects with any untimed lyric line (or no lyric lines at all)
 * private. Fully timed projects are left alone. Idempotent: matching requires
 * `public: true`, so a second run finds nothing.
 *
 * `updatedAt` and `contentUpdatedAt` are deliberately not touched (visibility
 * is not an edit, same choice as backfill-owner-visibility), and
 * `firstPublishedAt` is kept so a later re-publish does not announce again.
 * Sends one `system` notification per owner, never per project; owner-less
 * (guest) projects are privatized but notify nobody.
 */
export async function privatizeIncomplete(options: PrivatizeOptions): Promise<PrivatizeResult> {
  const { dryRun, evictNonOwners, log } = options;
  const matched: PrivatizeMatch[] = [];
  const perOwner = new Map<string, number>();
  let changed = 0;

  const cursor = Project.find({ public: true }).select('publicId title userId').lean().cursor();
  for await (const project of cursor) {
    const lyrics = await Lyrics.findOne({ publicId: project.publicId }).select('sections').lean<LyricsLines>();
    const { timed, total } = countLines(lyrics);
    if (total > 0 && timed === total) continue;

    matched.push({ publicId: project.publicId, title: project.title ?? '', timed, total });
    if (dryRun) continue;

    const res = await Project.updateOne(
      { publicId: project.publicId, public: true },
      { $set: { public: false } },
      { timestamps: false },
    );
    if (res.modifiedCount === 0) continue;
    changed++;

    const ownerId = project.userId ? project.userId.toString() : null;
    if (ownerId) perOwner.set(ownerId, (perOwner.get(ownerId) ?? 0) + 1);
    if (evictNonOwners) {
      try { await evictNonOwners(project.publicId, ownerId); } catch { /* best effort */ }
    }
  }

  for (const [ownerId, count] of perOwner) {
    try {
      await notifyProjectsPrivatized(ownerId, count);
    } catch (err) {
      log?.(`notification failed for ${ownerId}: ${(err as Error).message}`);
    }
  }
  return { matched, changed };
}
