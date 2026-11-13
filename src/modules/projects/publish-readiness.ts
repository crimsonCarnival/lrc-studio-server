/**
 * Server half of the client's `publish-readiness.ts`: a project may be public only with a title
 * and every lyric line timed. The client gates its Publish button on the same rule, but that is
 * UI only — this is what actually refuses the write.
 *
 * A line is timed by its start time or by any word time (an end time alone does not count), and
 * section markers are not lyric lines. Same rule as sync-stats and the privatize migration.
 */

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

export const PROJECT_INCOMPLETE = {
  error: 'A project needs a title and every lyric line timed before it can be published',
  status: 409,
  code: 'project_incomplete',
} as const;
