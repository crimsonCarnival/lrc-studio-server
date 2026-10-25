import { describe, it, expect } from 'vitest';
import { COUNTERPART_MARKER, compileLRC, parseLrcSrtFile } from './lrc.js';
import type { LineEntry } from './lrc.js';

// Linkin Park, "Crawling": the counterpart starts during "closing in" and runs on
// under the next line.
const song: LineEntry[] = [
  { text: 'My walls are closing in', timestamp: 72.4 },
  {
    text: 'Without a sense of confidence',
    timestamp: 73.05,
    adLibOf: 72.4,
    words: [
      { word: 'Without', time: 73.05 },
      { word: 'a', time: 73.6 },
      { word: 'sense', time: 73.8 },
      { word: 'of', time: 74.2 },
      { word: 'confidence', time: 79.2 },
    ],
  },
  { text: "I've felt this way before", timestamp: 76.8 },
];

const strip = (lines: LineEntry[]) => lines.map(({ id: _id, ...rest }) => rest);

describe('counterparts in LRC', () => {
  it('writes the marker right before a counterpart only', () => {
    const out = compileLRC(song).split('\n');
    expect(out).toEqual([
      '[01:12.40] My walls are closing in',
      COUNTERPART_MARKER,
      '[01:13.05] <01:13.05>Without <01:13.60>a <01:13.80>sense <01:14.20>of <01:19.20>confidence',
      "[01:16.80] I've felt this way before",
    ]);
  });

  it('round-trips: the marked line comes back as a counterpart of the line above', () => {
    const parsed = strip(parseLrcSrtFile(compileLRC(song), 'song.lrc'));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ text: 'My walls are closing in', timestamp: 72.4 });
    expect(parsed[0].adLibOf).toBeUndefined();
    expect(parsed[1]).toMatchObject({ text: 'Without a sense of confidence', timestamp: 73.05, adLibOf: 72.4 });
    expect(parsed[1].words?.at(-1)).toEqual({ word: 'confidence', time: 79.2 });
    expect(parsed[2].adLibOf).toBeUndefined();
  });

  it('keeps a counterpart that starts with its parent apart instead of merging it as a secondary', () => {
    const lrc = `[00:10.00] Main\n${COUNTERPART_MARKER}\n[00:10.00] Over it`;
    const parsed = parseLrcSrtFile(lrc, 'x.lrc');
    expect(parsed).toHaveLength(2);
    expect(parsed[0].secondary).toBeUndefined();
    expect(parsed[1]).toMatchObject({ text: 'Over it', adLibOf: 10 });
  });

  it('applies the marker to the next line only, and ignores it with no line above', () => {
    const lrc = `${COUNTERPART_MARKER}\n[00:01.00] First\n[00:02.00] Second\n${COUNTERPART_MARKER}\n\n[00:02.50] Over\n[00:03.00] Third`;
    const parsed = parseLrcSrtFile(lrc, 'x.lrc');
    expect(parsed.map((l) => l.adLibOf ?? null)).toEqual([null, null, 2, null]);
  });
});
