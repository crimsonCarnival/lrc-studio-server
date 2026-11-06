import { describe, it, expect } from 'vitest';
import { computeSyncStats, tagTimedLines, lineWeight, SOURCE_WEIGHT } from './sync-stats.js';
import { MAX_TIME_SECONDS } from '../lyrics/lyrics.model.js';

const doc = (lines: Array<Record<string, unknown>>) => ({ sections: [{ lines }] });
const timed = (n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({ text: `l${i}`, timestamp: (i + 1) * 10, ...extra }));
const seconds = (s: { minutesSynced: number; secondsSynced: number }) => s.minutesSynced * 60 + s.secondsSynced;

describe('lineWeight', () => {
  it('counts hand-marked, legacy and unknown sources in full', () => {
    expect(lineWeight('manual')).toBe(1);
    expect(lineWeight(null)).toBe(1);
    expect(lineWeight(undefined)).toBe(1);
    expect(lineWeight('something-else')).toBe(1);
  });

  it('discounts AI and imported timings and zeroes forked ones', () => {
    expect(lineWeight('asr')).toBe(SOURCE_WEIGHT.asr);
    expect(lineWeight('import')).toBe(SOURCE_WEIGHT.import);
    expect(lineWeight('fork')).toBe(0);
  });
});

describe('computeSyncStats', () => {
  it('counts a fully hand-synced song in full', () => {
    const s = computeSyncStats([doc(timed(10))]);
    expect(s.syncedLines).toBe(10);
    expect(seconds(s)).toBe(100); // last timestamp 100 s, 100% complete
  });

  it('weights lines by who timed them', () => {
    const s = computeSyncStats([doc([...timed(10, { source: 'manual' }), ...timed(10, { source: 'asr' }), ...timed(10, { source: 'fork' })])]);
    expect(s.syncedLines).toBe(13); // 10 + 10 * 0.3 + 0
    expect(s.aiSyncedLines).toBe(10); // raw count, for display
  });

  it('scales minutes by completion, so one stamp near the end earns little', () => {
    const lines = [{ text: 'a', timestamp: 3000 }, ...Array.from({ length: 9 }, (_, i) => ({ text: `b${i}`, timestamp: null }))];
    expect(seconds(computeSyncStats([doc(lines)]))).toBe(300); // 3000 s x 1/10
  });

  it('ignores blank placeholder lines when judging completion', () => {
    const s = computeSyncStats([doc([{ text: 'a', timestamp: 60 }, { text: '', timestamp: null }, { text: '', timestamp: null }])]);
    expect(seconds(s)).toBe(60);
  });

  it('clamps stored timestamps beyond the allowed range', () => {
    expect(seconds(computeSyncStats([doc([{ text: 'a', timestamp: 1e300 }])]))).toBe(MAX_TIME_SECONDS);
    expect(seconds(computeSyncStats([doc([{ text: 'a', timestamp: -50 }])]))).toBe(0);
  });

  it('weights word timings and karaoke lines too', () => {
    const wordLine = (source?: string) => ({ text: 'x', timestamp: 1, ...(source ? { source } : {}), words: [{ time: 1 }, { time: 2 }, { time: null }] });
    const s = computeSyncStats([doc([wordLine(), wordLine('asr'), wordLine('fork')])]);
    expect(s.wordsSynced).toBe(2); // 2 + 2 * 0.3 + 0 = 2.6, floored
    expect(s.karaokeLines).toBe(1); // 1 + 0.3 + 0 = 1.3, floored
    expect(s.aiWordsSynced).toBe(2);
  });

  it('falls back to the legacy flat lines array and handles empty input', () => {
    expect(computeSyncStats([{ lines: timed(3) }]).syncedLines).toBe(3);
    expect(computeSyncStats([])).toEqual({ minutesSynced: 0, secondsSynced: 0, wordsSynced: 0, karaokeLines: 0, syncedLines: 0, aiSyncedLines: 0, aiWordsSynced: 0 });
  });

  it('sums seconds across projects before splitting into minutes', () => {
    const s = computeSyncStats([doc(timed(1, { timestamp: 90 })), doc(timed(1, { timestamp: 90 }))]);
    expect(s.minutesSynced).toBe(3);
    expect(s.secondsSynced).toBe(0);
  });
});

describe('tagTimedLines', () => {
  it('tags only timed lines and returns new objects', () => {
    const input = [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: null }, { text: 'c', words: [{ time: 2 }] }];
    const out = tagTimedLines(input, 'fork');
    expect(out.map((l) => (l as { source?: string }).source)).toEqual(['fork', undefined, 'fork']);
    expect(input[0]).not.toHaveProperty('source');
  });
});
