import type { AsrWord } from './groq.client.js';
import { AsrError } from './groq.client.js';

export type LineInput = { index: number; text: string; wordTokens?: string[] };
export type StampStatus = 'matched' | 'partial' | 'low' | 'none';
export type StampWordResult = { word: string; time: number | null };
export type StampResult = {
  index: number;
  timestamp: number | null;
  endTime: number | null;
  confidence: number;
  status: StampStatus;
  /** Per-word timestamps in lyric text order. null entries = unmatched tokens. null array = line had no match at all. */
  words: StampWordResult[] | null;
};

const DEFAULT_TOLERANCE = 0.75;
const GAP_PENALTY = -0.5;
const MISMATCH_PENALTY = -1;

/** Lowercase, NFKC-normalize, strip punctuation/symbols, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(' ') : [];
}

/** Preserve original (non-normalized) words in lyric text order. */
function tokenizeOriginal(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/**
 * Needleman-Wunsch global alignment between lyric tokens and ASR word tokens.
 * Monotonic by construction — this is what keeps repeated choruses in order.
 * Returns matched pairs [lyricTokenIdx, asrWordIdx].
 */
function alignTokens(lyricTokens: string[], asrTokens: string[], tolerance: number): Array<[number, number]> {
  const m = lyricTokens.length, n = asrTokens.length;
  // score + traceback matrices; O(m*n) — fine for song-sized inputs (~1k × ~1k)
  const score: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  const trace: Uint8Array[] = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1)); // 1=diag 2=up 3=left
  for (let i = 1; i <= m; i++) { score[i][0] = i * GAP_PENALTY; trace[i][0] = 2; }
  for (let j = 1; j <= n; j++) { score[0][j] = j * GAP_PENALTY; trace[0][j] = 3; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sim = similarity(lyricTokens[i - 1], asrTokens[j - 1]);
      const matchScore = sim >= tolerance ? sim : MISMATCH_PENALTY;
      const diag = score[i - 1][j - 1] + matchScore;
      const up = score[i - 1][j] + GAP_PENALTY;
      const left = score[i][j - 1] + GAP_PENALTY;
      if (diag >= up && diag >= left) { score[i][j] = diag; trace[i][j] = 1; }
      else if (up >= left) { score[i][j] = up; trace[i][j] = 2; }
      else { score[i][j] = left; trace[i][j] = 3; }
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    const t = trace[i][j];
    if (t === 1) {
      if (similarity(lyricTokens[i - 1], asrTokens[j - 1]) >= tolerance) pairs.push([i - 1, j - 1]);
      i--; j--;
    } else if (t === 2) i--;
    else j--;
  }
  pairs.reverse();
  return pairs;
}

const MAX_ALIGN_TOKENS = 20_000;

export function stampLines(lines: LineInput[], words: AsrWord[], opts?: { fuzzyTolerance?: number }): StampResult[] {
  const tolerance = opts?.fuzzyTolerance ?? DEFAULT_TOLERANCE;

  // Flatten lyric lines into one token stream, remembering each token's line and position-within-line.
  const lyricTokens: string[] = [];
  const tokenLine: number[] = [];
  const tokenPosInLine: number[] = []; // which word-slot within the line does this token belong to?
  const tokensPerLine = new Map<number, number>();
  // Capture original-casing tokens per line for the words output.
  const originalTokensPerLine = new Map<number, string[]>();
  for (const line of lines) {
    // If the client sent pre-segmented wordTokens (e.g. CJK/karaoke mode), use those
    // verbatim as the token list so that result.words[pos] maps 1:1 to line.words[pos].
    // Otherwise fall back to whitespace-tokenizing line.text.
    const toks = line.wordTokens
      ? line.wordTokens.map(w => normalizeText(w))
      : tokenize(line.text);
    const origToks = line.wordTokens ?? tokenizeOriginal(line.text);
    tokensPerLine.set(line.index, toks.length);
    originalTokensPerLine.set(line.index, origToks);
    for (let pos = 0; pos < toks.length; pos++) {
      lyricTokens.push(toks[pos]);
      tokenLine.push(line.index);
      tokenPosInLine.push(pos);
    }
  }

  // alignTokens builds O(m*n) score/traceback matrices — unbounded lyric or
  // word-list sizes would let a hostile/huge input exhaust memory (OOM).
  if (lyricTokens.length > MAX_ALIGN_TOKENS || words.length > MAX_ALIGN_TOKENS) {
    throw new AsrError('asr_unsupported_audio', 'alignment input too large');
  }

  const asrTokens = words.map(w => normalizeText(w.text));
  const pairs = alignTokens(lyricTokens, asrTokens, tolerance);

  // Collect matched word times per line.
  const perLine = new Map<number, { start: number; end: number; matched: number }>();
  // perLineWordTimes: lineIdx -> (wordPos -> ASR word start time)
  const perLineWordTimes = new Map<number, Map<number, number>>();

  for (const [li, wi] of pairs) {
    const lineIdx = tokenLine[li];
    const wordPos = tokenPosInLine[li];
    const word = words[wi];
    const entry = perLine.get(lineIdx);
    if (!entry) perLine.set(lineIdx, { start: word.start, end: word.end, matched: 1 });
    else {
      entry.start = Math.min(entry.start, word.start);
      entry.end = Math.max(entry.end, word.end);
      entry.matched++;
    }
    let posMap = perLineWordTimes.get(lineIdx);
    if (!posMap) { posMap = new Map(); perLineWordTimes.set(lineIdx, posMap); }
    posMap.set(wordPos, word.start);
  }

  return lines.map(line => {
    const total = tokensPerLine.get(line.index) ?? 0;
    const entry = perLine.get(line.index);
    if (!entry || total === 0) {
      return { index: line.index, timestamp: null, endTime: null, confidence: 0, status: 'none' as const, words: null };
    }
    const confidence = entry.matched / total;
    const status: StampStatus = confidence >= 0.8 ? 'matched' : confidence >= 0.5 ? 'partial' : 'low';

    // Build per-word results in lyric text order, preserving original casing.
    const posMap = perLineWordTimes.get(line.index);
    const origToks = originalTokensPerLine.get(line.index) ?? [];
    const wordResults: StampWordResult[] = origToks.map((w, pos) => ({
      word: w,
      time: posMap?.get(pos) ?? null,
    }));

    return {
      index: line.index,
      timestamp: entry.start,
      endTime: entry.end,
      confidence,
      status,
      words: wordResults.length > 0 ? wordResults : null,
    };
  });
}
