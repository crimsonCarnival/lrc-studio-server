import { describe, it, expect } from 'vitest';
import { compileLRC, parseWordTimestamps } from './lrc.js';
import type { LineEntry } from './lrc.js';

// FLOW, "GO!!!": "dreamers" stops before 高み starts, and the last word ends with the line.
const line: LineEntry = {
  text: 'We are fighting dreamers',
  timestamp: 8.88,
  words: [
    { word: 'We', time: 8.88 },
    { word: 'are', time: 8.99 },
    { word: 'fighting', time: 9.42, end: 10.33 },
    { word: 'dreamers', time: 10.33, end: 10.98 },
  ],
};

describe('word end times in enhanced LRC', () => {
  it('closes a word with an empty timed token only when it stops before the next word', () => {
    expect(compileLRC([line])).toBe(
      '[00:08.88] <00:08.88>We <00:08.99>are <00:09.42>fighting <00:10.33>dreamers<00:10.98>',
    );
  });

  it('reads the empty token back as the end of the word before it', () => {
    const words = parseWordTimestamps('<00:10.33>dreamers<00:10.98> <00:11.12>takami');
    expect(words).toEqual([
      { word: 'dreamers', time: 10.33, end: 10.98 },
      { word: 'takami', time: 11.12 },
    ]);
  });
});
