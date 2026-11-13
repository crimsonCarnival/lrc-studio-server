/**
 * Server half of the client's `publish-readiness.ts`: a project may be public only with a title
 * and every lyric line timed. The client gates its Publish button on the same rule, but that is
 * UI only — this is what actually refuses the write.
 *
 * A line is timed by its start time or by any word time (an end time alone does not count), and
 * section markers are not lyric lines. Same rule as sync-stats and the privatize migration.
 */

import type mongoose from 'mongoose';
import Project from './project.model.js';
import { notifyProjectsPrivatized } from '../notifications/notifications.service.js';
import { getIO } from '../../socket/socket.manager.js';

type ReadinessLine = { type?: string | null; timestamp?: number | null; words?: { time?: number | null }[] | null };
export type ReadinessSections = { lines?: ReadinessLine[] | null }[] | null | undefined;

export function countTimedLines(sections: ReadinessSections): { timed: number; total: number } {
  let timed = 0;
  let total = 0;
  for (const section of sections ?? []) {
    for (const line of section?.lines ?? []) {
      if (line?.type === 'section') continue;
      total++;
      if (line.timestamp != null || (line.words ?? []).some((w) => w?.time != null)) timed++;
    }
  }
  return { timed, total };
}

export function linesComplete(sections: ReadinessSections): boolean {
  const { timed, total } = countTimedLines(sections);
  return total > 0 && timed === total;
}

export function isPublishable(title: string | null | undefined, sections: ReadinessSections): boolean {
  return !!title?.trim() && linesComplete(sections);
}

/**
 * The other half of the publish rule: a public project saved into an unfinished state (an untimed
 * line added, a timestamp cleared) goes private instead of staying live half-done. Every lyric
 * write path calls it: patch/updateProject, the updateLyrics mutation and the collab store. Only
 * checked when the save touched what the rule reads. Conditional on `public: true`, so concurrent
 * saves notify once. `firstPublishedAt` is kept, so republishing does not re-announce to followers.
 * Visibility is not an edit: timestamps are not bumped. Returns whether it unpublished; the caller
 * evicts non-owners from the project's socket room where it has one.
 */
export async function unpublishIfIncomplete(
  publicId: string,
  saved: { public?: boolean | null; title?: string | null; userId?: mongoose.Types.ObjectId | null },
  sections: ReadinessSections,
  touched: boolean,
): Promise<boolean> {
  if (!saved.public || !touched || isPublishable(saved.title, sections)) return false;
  const res = await Project.updateOne({ publicId, public: true }, { $set: { public: false } }, { timestamps: false });
  if (res.modifiedCount !== 1) return false;
  if (saved.userId) {
    const ownerId = saved.userId.toString();
    notifyProjectsPrivatized(ownerId, 1).catch(() => {});
    // Every tab of the owner, including the one that saved: the room broadcast skips the saver's
    // socket, and the editor holds visibility in its own state, so it must be told.
    try { getIO().to(`user:${ownerId}`).emit('project:visibility', { publicId, public: false }); } catch { /* socket not ready */ }
  }
  return true;
}

export const PROJECT_INCOMPLETE = {
  error: 'A project needs a title and every lyric line timed before it can be published',
  status: 409,
  code: 'project_incomplete',
} as const;
