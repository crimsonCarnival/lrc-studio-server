import { describe, it, expect } from 'vitest';
import { isValidReaction, REACTION_CODES, REACTION_MAX_LENGTH } from './reaction.emoji.js';

describe('isValidReaction', () => {
  it('accepts every quick-reaction code', () => {
    for (const code of REACTION_CODES) expect(isValidReaction(code)).toBe(true);
  });

  it('accepts a single emoji, including multi-codepoint ones', () => {
    for (const emoji of ['🎉', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🇨🇴', '🏳️‍🌈', '1️⃣', '#️⃣']) {
      expect(isValidReaction(emoji), emoji).toBe(true);
    }
  });

  it('rejects plain text, even text that looks like a code', () => {
    for (const text of ['hello', 'Heart', 'heart ', 'a', '7', '#', '']) {
      expect(isValidReaction(text), JSON.stringify(text)).toBe(false);
    }
  });

  it('rejects more than one emoji and emoji mixed with text', () => {
    for (const value of ['🎉🎉', '🔥 ', ' 🔥', 'a🔥', '🔥a', '❤️🔥']) {
      expect(isValidReaction(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects markup', () => {
    expect(isValidReaction('<img src=x onerror=alert(1)>')).toBe(false);
    expect(isValidReaction('<b>🔥</b>')).toBe(false);
  });

  it('rejects an emoji padded past the length cap with combining marks', () => {
    const zalgo = '🔥' + '́'.repeat(REACTION_MAX_LENGTH);
    expect(isValidReaction(zalgo)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 1, {}, ['🔥']]) expect(isValidReaction(value)).toBe(false);
  });
});
