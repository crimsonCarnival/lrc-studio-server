import { describe, it, expect } from 'vitest';
import { inferEndTimes } from './lrc.js';
import { compileSRT } from './srt.js';

const lines = [{ text: 'a', timestamp: 1 }, { text: 'b', timestamp: 4 }];

describe('minimum subtitle gap', () => {
  it('a gap of 0 is a choice, not a missing value', () => {
    expect(inferEndTimes(lines, 10, { minSubtitleGap: 0 })[0].endTime).toBe(4);
    expect(compileSRT(lines, 10, false, 'lf', { minSubtitleGap: 0 })).toContain('00:00:01,000 --> 00:00:04,000');
  });

  it('an unset gap still defaults to 50 ms', () => {
    expect(inferEndTimes(lines, 10, {})[0].endTime).toBeCloseTo(3.95);
  });
});
