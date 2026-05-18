const KANJI_RE = /[\u4E00-\u9FAF\u3400-\u4DBF\uF900-\uFAFF]/;

export function toHiragana(katakana: string): string {
  if (!katakana) return '';
  return katakana.replace(/[\u30A1-\u30F6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

export function toKatakana(hiragana: string): string {
  if (!hiragana) return '';
  return hiragana.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

export function isKanji(ch: string): boolean {
  return KANJI_RE.test(ch);
}

export function hasCJK(text: string): boolean {
  return /[\u3000-\u9FFF\uF900-\uFAFF]/.test(text);
}

export interface RubySegment {
  text: string;
  reading: string | null;
}

export interface RubyParseResult {
  plainText: string;
  segments: RubySegment[];
}

export function parseRubyMarkup(input: string): RubyParseResult {
  if (!input) return { plainText: '', segments: [] };
  const segments: RubySegment[] = [];
  let plainText = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] === '{') {
      const close = input.indexOf('}', i + 1);
      if (close === -1) {
        const raw = input.slice(i);
        plainText += raw;
        if (raw) segments.push({ text: raw, reading: null });
        break;
      }
      const inner = input.slice(i + 1, close);
      const pipeIdx = inner.indexOf('|');
      if (pipeIdx === -1) {
        plainText += inner;
        if (inner) segments.push({ text: inner, reading: null });
      } else {
        const word = inner.slice(0, pipeIdx);
        const reading = inner.slice(pipeIdx + 1).trim();
        plainText += word;
        // Only attach a reading when the word contains at least one kanji.
        // Non-kanji tokens (kana, latin, …) inside {word|reading} blocks are
        // treated as plain text — the reading is silently dropped.
        const hasKanjiInWord = word && KANJI_RE.test(word);
        if (word) segments.push({ text: word, reading: (hasKanjiInWord && reading) ? reading : null });
      }
      i = close + 1;
    } else {
      let j = i;
      while (j < input.length && input[j] !== '{') j++;
      const raw = input.slice(i, j);
      plainText += raw;
      if (raw) segments.push({ text: raw, reading: null });
      i = j;
    }
  }
  return { plainText, segments };
}

export interface WordWithReading {
  word: string;
  reading?: string;
}

export function serializeToRubyMarkup(words: WordWithReading[]): string {
  if (!words?.length) return '';
  return words.map((w, i) => {
    const serialized = w.reading ? `{${w.word}|${w.reading}}` : w.word;
    const needsSpace = i < words.length - 1 && /[a-zA-Z0-9]/.test(w.word);
    return needsSpace ? serialized + ' ' : serialized;
  }).join('');
}