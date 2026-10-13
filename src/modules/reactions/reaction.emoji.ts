/** The quick reactions, stored by code so their artwork and name can change without a migration. */
export const REACTION_CODES = ['heart', 'fire', 'wow', 'laugh', 'clap', 'music'] as const;

// A ZWJ family or flag sequence is ~11 UTF-16 units; 32 leaves room without letting a
// single "grapheme" carry a pile of combining marks.
export const REACTION_MAX_LENGTH = 32;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Pictographs, flag halves, and the keycap mark (which follows a plain digit, # or *).
const EMOJI_PART = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/**
 * A reaction is either one of the quick-reaction codes or exactly one emoji.
 * This is the only gate between user input and the reactions collection (and the
 * notification body it is copied into), so it rejects anything that is not a single
 * emoji grapheme: text, markup, several emoji, or the empty string.
 */
export function isValidReaction(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if ((REACTION_CODES as readonly string[]).includes(value)) return true;
  if (value.length === 0 || value.length > REACTION_MAX_LENGTH) return false;
  let count = 0;
  for (const _segment of graphemes.segment(value)) {
    if (++count > 1) return false;
  }
  return EMOJI_PART.test(value);
}
