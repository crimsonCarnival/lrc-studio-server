import { MAX_TIME_SECONDS } from '../lyrics/lyrics.model.js';

/**
 * How much of a timed line counts toward a user's sync stats, by who timed it.
 * Hand-marked work counts in full. AI-stamped and imported timings are real but cost the user
 * little, so they count at a reduced rate. A forked line counts for nothing until the forker
 * re-times it (the editor then marks it 'manual').
 *
 * 0.3 and 0 are assumptions from the audit's product decisions; change them here.
 * Missing or unknown sources are legacy lines and count as manual.
 */
export const SOURCE_WEIGHT: Record<string, number> = { manual: 1, asr: 0.3, import: 0.3, fork: 0 };

export function lineWeight(source: unknown): number {
  return typeof source === 'string' && source in SOURCE_WEIGHT ? SOURCE_WEIGHT[source] : 1;
}

type SyncLine = {
  text?: string | null;
  timestamp?: number | null;
  words?: Array<{ time?: number | null }> | null;
  source?: string | null;
};
type SyncDoc = { sections?: Array<{ lines?: SyncLine[] | null }> | null; lines?: SyncLine[] | null };

export type SyncStats = {
  minutesSynced: number;
  secondsSynced: number;
  wordsSynced: number;
  karaokeLines: number;
  syncedLines: number;
  /** Raw (unweighted) count of AI-stamped synced lines, for display. */
  aiSyncedLines: number;
  /** Raw count of AI-stamped timed words, for display. */
  aiWordsSynced: number;
};

const timedWords = (l: SyncLine): number => (l.words ?? []).filter((w) => w?.time != null).length;
const isSynced = (l: SyncLine): boolean => l.timestamp != null || timedWords(l) > 0;

/**
 * Sync stats of one user from their lyrics documents.
 *
 * Every figure is weighted by line source (see SOURCE_WEIGHT). Minutes are the project's last
 * timestamp scaled by how much of the song is synced (weighted synced lines over all lyric
 * lines), so a single stamp near the end of a song earns no more than the work behind it.
 * Timestamps are clamped to [0, MAX_TIME_SECONDS], which also neutralises any out-of-range
 * value stored before the write path validated them.
 */
export function computeSyncStats(docs: SyncDoc[]): SyncStats {
  let seconds = 0;
  let words = 0;
  let karaoke = 0;
  let synced = 0;
  let aiLines = 0;
  let aiWords = 0;

  for (const doc of docs) {
    const sectionLines = (doc.sections ?? []).flatMap((s) => s.lines ?? []);
    const lines = sectionLines.length > 0 ? sectionLines : (doc.lines ?? []);

    let lyricLines = 0;
    let weightedSynced = 0;
    let lastTimestamp = 0;

    for (const line of lines) {
      const w = lineWeight(line.source);
      const wordCount = timedWords(line);
      if (wordCount > 0) {
        words += wordCount * w;
        karaoke += w;
        if (line.source === 'asr') aiWords += wordCount;
      }
      if (typeof line.timestamp === 'number') {
        lastTimestamp = Math.max(lastTimestamp, Math.min(Math.max(line.timestamp, 0), MAX_TIME_SECONDS));
      }
      // Blank lines are placeholders (shown as ♪), not lyrics.
      if (!line.text) continue;
      lyricLines++;
      if (isSynced(line)) {
        weightedSynced += w;
        if (line.source === 'asr') aiLines++;
      }
    }

    synced += weightedSynced;
    if (lyricLines > 0) seconds += lastTimestamp * Math.min(1, weightedSynced / lyricLines);
  }

  return {
    minutesSynced: Math.floor(seconds / 60),
    secondsSynced: Math.floor(seconds % 60),
    wordsSynced: Math.floor(words),
    karaokeLines: Math.floor(karaoke),
    syncedLines: Math.floor(synced),
    aiSyncedLines: aiLines,
    aiWordsSynced: aiWords,
  };
}

/** Marks every timed line with `source`, leaving untimed lines alone. Returns new objects. */
export function tagTimedLines<T extends SyncLine>(lines: T[], source: 'import' | 'fork'): T[] {
  return lines.map((l) => (l && typeof l === 'object' && isSynced(l) ? { ...l, source } : l));
}
