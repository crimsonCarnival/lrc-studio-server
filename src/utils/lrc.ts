import crypto from 'node:crypto';
import { serializeToRubyMarkup, parseRubyMarkup } from './furigana.js';
import type { RubySegment } from './furigana.js';

// SRT utilities live in srt.ts; re-export SrtConfig so existing imports from lrc.ts still work.
import type { SrtConfig } from './srt.js';
export type { SrtConfig } from './srt.js';

export interface WordEntry {
  word: string;
  time?: number | null;
  reading?: string;
}

export interface SecondaryWordEntry {
  word: string;
  time?: number | null;
}

export interface LineEntry {
  text: string;
  timestamp: number | null;
  endTime?: number | null;
  secondary?: string | null;
  translation?: string | null;
  translations?: Array<{ text: string; language?: string | null }>;
  id?: string;
  words?: WordEntry[];
  secondaryWords?: SecondaryWordEntry[];
}


function buildSecondaryText(line: LineEntry, wordPrecision?: string): string | null {
  if (line.secondaryWords?.length && line.secondaryWords.some(w => w.time != null)) {
    return formatWordsToLrc(line.secondaryWords, wordPrecision);
  }
  if (line.words?.some(w => w.reading)) {
    return serializeToRubyMarkup(line.words);
  }
  return line.secondary || null;
}

function formatWordsToLrc(words: Array<{ word: string; time?: number | null }>, precision = 'hundredths'): string {
  const cjk = (ch: string): boolean => {
    const c = ch?.codePointAt(0) ?? 0;
    return (c >= 0x3000 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0x20000 && c <= 0x2FA1F);
  };
  return words.map((w, i, arr) => {
    const ts = w.time != null ? formatWordTimestamp(w.time, precision) : '';
    const token = `${ts}${w.word}`;
    const next = arr[i + 1];
    if (!next) return token;
    const lastChar = w.word.slice(-1);
    const firstChar = next.word.slice(0, 1);
    return cjk(lastChar) || cjk(firstChar) ? token : token + ' ';
  }).join('');
}

function formatWordTimestamp(seconds: number, precision = 'hundredths'): string {
  if (seconds == null) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const mm = String(mins).padStart(2, '0');
  const decimals = precision === 'thousandths' ? 3 : 2;
  const padLen = decimals + 3;
  const ss = secs.toFixed(decimals).padStart(padLen, '0');
  return `<${mm}:${ss}>`;
}

function sanitizeLrcTag(s: unknown): string {
  if (typeof s !== 'string') return String(s || '');
  return s.replace(/[[\]]/g, '');
}

export function formatTimestamp(seconds: number | null | undefined, precision = 'hundredths'): string {
  if (seconds == null || isNaN(seconds) || seconds < 0) {
    return precision === 'thousandths' ? '00:00.000' : '00:00.00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const mm = String(mins).padStart(2, '0');
  const decimals = precision === 'thousandths' ? 3 : 2;
  const padLen = decimals + 3;
  const ss = secs.toFixed(decimals).padStart(padLen, '0');
  return `${mm}:${ss}`;
}

export function parseTimestamp(str: string): number | null {
  const match = str.match(/\[(\d{2}):(\d{2}\.\d{2,3})\]/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseFloat(match[2]);
}

export function formatSrtTimestamp(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '00:00:00,000';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function parseWordTimestamps(text: string): WordEntry[] {
  const re = /<(\d{1,2}):(\d{2}\.\d{2,3})>([^<]*)/g;
  const words: WordEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
    const word = match[3].trimEnd();
    if (word) words.push({ word, time });
  }
  const hasCJK = words.some(w => /[\u3000-\u9FFF\uF900-\uFAFF]/.test(w.word));
  if (hasCJK && words.length > 0) {
    const expanded: WordEntry[] = [];
    const isCJKChar = (ch: string) => /[\u3000-\u9FFF\uF900-\uFAFF]/.test(ch);
    words.forEach((w, wi) => {
      const codePoints = [...w.word].filter(ch => ch.trim());
      if (!codePoints.some(isCJKChar)) { expanded.push(w); return; }
      if (codePoints.length <= 1) { expanded.push(w); return; }
      const nextTime = words[wi + 1]?.time;
      const duration = nextTime != null ? nextTime - w.time! : null;
      const subTokens: string[] = [];
      let ci = 0;
      while (ci < codePoints.length) {
        const ch = codePoints[ci];
        if (isCJKChar(ch)) {
          subTokens.push(ch);
          ci++;
        } else {
          let j = ci;
          while (j < codePoints.length && !isCJKChar(codePoints[j])) j++;
          subTokens.push(codePoints.slice(ci, j).join(''));
          ci = j;
        }
      }
      subTokens.forEach((token, si) => {
        const t = duration != null
          ? w.time! + (duration * si / subTokens.length)
          : w.time! + si * 0.1;
        expanded.push({ word: token, time: parseFloat(t.toFixed(3)) });
      });
    });
    return expanded;
  }
  return words;
}

export function compileLRC(
  lines: LineEntry[],
  includeTranslations = false,
  precision = 'hundredths',
  metadata: Record<string, string | undefined> = {},
  lineEndings = 'lf',
  includeSecondary = false,
  wordPrecision?: string,
  exportTranslationIndex = 0
): string {
  const wp = wordPrecision || precision;
  let header = '';
  if (metadata.ti) header += `[ti:${sanitizeLrcTag(metadata.ti)}]\n`;
  if (metadata.ar) header += `[ar:${sanitizeLrcTag(metadata.ar)}]\n`;
  if (metadata.al) header += `[al:${sanitizeLrcTag(metadata.al)}]\n`;
  if (metadata.lg) header += `[lg:${sanitizeLrcTag(metadata.lg)}]\n`;

  const body = lines
    .flatMap((line) => {
      if (line.timestamp != null) {
        const ts = line.timestamp;
        const wordText = line.words?.length
          ? formatWordsToLrc(line.words, wp)
          : line.text;
        let out = `[${formatTimestamp(ts, precision)}] ${wordText}`;
        if (includeSecondary) {
          const sec = buildSecondaryText(line, wp);
          if (sec) out += `\n[${formatTimestamp(ts, precision)}] ${sec}`;
        }
        if (includeTranslations) {
          const translationText = line.translations?.[exportTranslationIndex]?.text ?? line.translation ?? null;
          if (translationText) out += `\n[${formatTimestamp(ts, precision)}] ${translationText}`;
        }
        return out;
      }
      return [line.text];
    })
    .join('\n');

  const result = header + body;
  return lineEndings === 'crlf' ? result.replace(/\n/g, '\r\n') : result;
}

// compileSRT has moved to srt.ts — import it from there.

export function parseLrcSrtFile(content: string, filename: string, options: { preserveEmptyLines?: boolean } = {}): LineEntry[] {
  const isSrt = filename.toLowerCase().endsWith('.srt');
  const parsedLines: LineEntry[] = [];

  if (isSrt) {
    const blocks = content.replace(/\r\n/g, '\n').split('\n\n');
    blocks.forEach(block => {
      const parts = block.trim().split('\n');
      if (parts.length >= 3) {
        const timeMatch = parts[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
        if (timeMatch) {
          const timestamp = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 +
            parseInt(timeMatch[3], 10) + parseInt(timeMatch[4], 10) / 1000;
          const endTime = parseInt(timeMatch[5], 10) * 3600 + parseInt(timeMatch[6], 10) * 60 +
            parseInt(timeMatch[7], 10) + parseInt(timeMatch[8], 10) / 1000;
          const text = parts.slice(2).join('\n');
          parsedLines.push({ text, timestamp, endTime, secondary: '', translation: '', id: crypto.randomUUID() });
        }
      }
    });
  } else {
    const lrcLines = content.replace(/\r\n/g, '\n').split('\n');
    lrcLines.forEach(line => {
      let remaining = line.trim();
      const tsStepRe = /^\[(\d{1,2}):(\d{2}\.\d{2,3})\]/;
      const collectedTs: number[] = [];
      let step: RegExpMatchArray | null;
      while ((step = remaining.match(tsStepRe))) {
        collectedTs.push(parseInt(step[1], 10) * 60 + parseFloat(step[2]));
        remaining = remaining.slice(step[0].length);
      }
      if (collectedTs.length > 0) {
        const rawText = remaining.trim();
        const words = parseWordTimestamps(rawText);
        const text = rawText.replace(/<\d{1,2}:\d{2}\.\d{2,3}>/g, '').trim();
        collectedTs.sort((a, b) => a - b);
        const [primary] = collectedTs;
        const entry: LineEntry = { text, timestamp: primary, id: crypto.randomUUID() };
        if (words.length > 0) entry.words = words;
        parsedLines.push(entry);
      } else if (remaining !== '' && !/^\[[^\]]*:[^\]]*\]/.test(remaining)) {
        parsedLines.push({ text: remaining.trim(), timestamp: null, id: crypto.randomUUID() });
      } else if (remaining === '' && options.preserveEmptyLines) {
        parsedLines.push({ text: '', timestamp: null, id: crypto.randomUUID() });
      }
    });
  }

  const mergedLines: LineEntry[] = [];
  const timestampMap = new Map<number, number>();

  for (const line of parsedLines) {
    if (line.timestamp == null) {
      mergedLines.push(line);
      continue;
    }
    const key = Math.round(line.timestamp * 100);
    if (timestampMap.has(key)) {
      const existingIndex = timestampMap.get(key)!;
      const existing = mergedLines[existingIndex];
      if (!existing.secondary && !existing.translation) {
        const secWords = parseWordTimestamps(line.text);
        if (secWords.length > 0) {
          existing.secondaryWords = secWords;
          existing.secondary = line.text.replace(/<\d{1,2}:\d{2}\.\d{2,3}>/g, '').trim();
        } else if (/\{[^|{]+\|[^}]+\}/.test(line.text)) {
          const { plainText, segments } = parseRubyMarkup(line.text);
          existing.secondary = plainText;

          if (!existing.words?.length) {
            existing.words = segments.map((s: RubySegment) => ({
              word: s.text,
              reading: s.reading || undefined,
              time: undefined,
            })).filter(w => w.word.trim());
          } else {
            const oldWords = [...existing.words];
            const newWords: WordEntry[] = [];
            let oldIdx = 0;

            for (const seg of segments) {
              const segText = seg.text;
              if (!segText) continue;

              let consumed = '';
              let firstTime: number | null | undefined = null;

              while (oldIdx < oldWords.length && consumed.length < segText.length) {
                const w = oldWords[oldIdx];
                if (firstTime === null) firstTime = w.time;
                consumed += w.word;
                oldIdx++;
              }

              newWords.push({
                word: segText,
                reading: seg.reading || undefined,
                time: firstTime,
              });
            }
            if (oldIdx < oldWords.length) {
              newWords.push(...oldWords.slice(oldIdx));
            }
            existing.words = newWords;
          }
        } else {
          existing.secondary = line.text;
        }
      } else if (!existing.translation) {
        existing.translation = line.text;
      }
    } else {
      const idx = mergedLines.length;
      mergedLines.push({ ...line });
      timestampMap.set(key, idx);
    }
  }

  return mergedLines;
}

export function inferEndTimes(lines: LineEntry[], duration?: number | null, srtConfig: SrtConfig = {}): LineEntry[] {
  const minGap = srtConfig.minSubtitleGap || 0.05;
  const defaultDur = srtConfig.defaultSubtitleDuration || 5;

  return lines.map((line, i) => {
    if (line.endTime != null) return line;
    if (line.timestamp == null) return line;

    let nextStart: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].timestamp != null) {
        nextStart = lines[j].timestamp;
        break;
      }
    }

    let endTime: number;
    if (nextStart != null) {
      endTime = Math.max(line.timestamp + minGap, nextStart - minGap);
    } else if (duration) {
      endTime = Math.min(line.timestamp + defaultDur, duration);
    } else {
      endTime = line.timestamp + defaultDur;
    }

    return { ...line, endTime };
  });
}