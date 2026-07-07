import { describe, it, expect } from 'vitest';
import { stampLines } from './align.service.js';
import type { AsrWord } from './groq.client.js';

function w(text: string, start: number, end: number): AsrWord { return { text, start, end }; }

describe('stampLines', () => {
  it('stamps exact matches with line start/end from first/last word', () => {
    const lines = [{ index: 0, text: 'hello world' }, { index: 1, text: 'goodbye moon' }];
    const words = [w('hello', 1, 1.4), w('world', 1.5, 2), w('goodbye', 5, 5.5), w('moon', 5.6, 6)];
    const r = stampLines(lines, words);
    expect(r[0]).toMatchObject({ index: 0, timestamp: 1, endTime: 2, status: 'matched', confidence: 1 });
    expect(r[1]).toMatchObject({ index: 1, timestamp: 5, endTime: 6, status: 'matched' });
    // word-level times preserved
    expect(r[0].words).toEqual([{ word: 'hello', time: 1 }, { word: 'world', time: 1.5 }]);
    expect(r[1].words).toEqual([{ word: 'goodbye', time: 5 }, { word: 'moon', time: 5.6 }]);
  });
  it('ignores punctuation and capitalization differences', () => {
    const r = stampLines([{ index: 0, text: '¡Hello, World!' }], [w('hello', 0, 1), w('world', 1, 2)]);
    expect(r[0].status).toBe('matched');
    expect(r[0].timestamp).toBe(0);
  });
  it('fuzzy-matches minor ASR mistakes', () => {
    const r = stampLines([{ index: 0, text: 'satellite hearts' }], [w('sattelite', 0, 1), w('hearts', 1, 2)]);
    expect(r[0].status).toBe('matched');
  });
  it('disambiguates repeated chorus lines monotonically', () => {
    const lines = [
      { index: 0, text: 'la la chorus' }, { index: 1, text: 'verse two here' }, { index: 2, text: 'la la chorus' },
    ];
    const words = [w('la', 0, 0.2), w('la', 0.3, 0.5), w('chorus', 0.6, 1),
      w('verse', 10, 10.5), w('two', 10.6, 11), w('here', 11.1, 11.5),
      w('la', 20, 20.2), w('la', 20.3, 20.5), w('chorus', 20.6, 21)];
    const r = stampLines(lines, words);
    expect(r[0].timestamp).toBe(0);
    expect(r[1].timestamp).toBe(10);
    expect(r[2].timestamp).toBe(20); // NOT 0 — monotonic ordering
  });
  it('never fabricates timestamps: unmatched line → none/null', () => {
    const r = stampLines(
      [{ index: 0, text: 'hello world' }, { index: 1, text: 'zzz qqq xxx' }],
      [w('hello', 0, 1), w('world', 1, 2)]);
    expect(r[1]).toMatchObject({ timestamp: null, endTime: null, status: 'none', confidence: 0 });
    expect(r[1].words).toBeNull();
  });
  it('partial match when only some tokens align', () => {
    const r = stampLines([{ index: 0, text: 'one two three four' }],
      [w('one', 0, 1), w('two', 1, 2), w('nope', 2, 3), w('nah', 3, 4)]);
    expect(r[0].status).toBe('partial');
    expect(r[0].confidence).toBe(0.5);
    // matched words have a time; unmatched get null
    expect(r[0].words).toEqual([
      { word: 'one', time: 0 },
      { word: 'two', time: 1 },
      { word: 'three', time: null },
      { word: 'four', time: null },
    ]);
  });
  it('handles unicode and accents', () => {
    const r = stampLines([{ index: 0, text: 'Corazón partío' }], [w('corazón', 3, 3.5), w('partío', 3.6, 4)]);
    expect(r[0].status).toBe('matched');
    expect(r[0].timestamp).toBe(3);
  });
  it('empty lines input → empty result; blank/whitespace lines → none', () => {
    expect(stampLines([], [w('x', 0, 1)])).toEqual([]);
    expect(stampLines([{ index: 0, text: '   ' }], [w('x', 0, 1)])[0].status).toBe('none');
  });
  it('is deterministic', () => {
    const lines = [{ index: 0, text: 'a b c' }, { index: 1, text: 'a b c' }];
    const words = [w('a', 0, 1), w('b', 1, 2), w('c', 2, 3), w('a', 9, 10), w('b', 10, 11), w('c', 11, 12)];
    expect(stampLines(lines, words)).toEqual(stampLines(lines, words));
  });
  it('rejects inputs over the alignment size cap to avoid O(m*n) OOM', () => {
    // 20_001 single-token lines rather than one huge line — keeps well under
    // the 1000-char-per-line schema limit while still exceeding the token cap.
    const lines = Array.from({ length: 20_001 }, (_, i) => ({ index: i, text: 'a' }));
    const words = [w('a', 0, 1)];
    expect(() => stampLines(lines, words)).toThrowError(
      expect.objectContaining({ code: 'asr_unsupported_audio' })
    );
  });
});
