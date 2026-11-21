/**
 * Reads the subtitle formats the editor imports besides SRT: WebVTT, YouTube's SBV and
 * (Advanced) SubStation Alpha. Each cue becomes a timed line with an end time, the same shape
 * the SRT branch of `parseLrcSrtFile` produces. Styling, positioning and karaoke tags are
 * dropped: the editor keeps text and timing only.
 *
 * Mirrored in client/src/shared/utils/subtitle-parse.ts for the offline parse fallback; keep
 * the two in step.
 */

export type SubtitleImportFormat = 'vtt' | 'sbv' | 'ass';

export type ParsedCue = { start: number; end: number; text: string };

const EXTENSIONS: Record<string, SubtitleImportFormat> = { vtt: 'vtt', sbv: 'sbv', ass: 'ass', ssa: 'ass' };

/** The subtitle format a file name names, or null for anything else (lrc, srt, txt…). */
export function subtitleImportFormat(filename: string): SubtitleImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return EXTENSIONS[ext] ?? null;
}

/** `[H:]MM:SS(.|,)fff` → seconds; the fraction may have 1–3 digits (ASS uses 2). */
function toSeconds(clock: string): number | null {
  const m = clock.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const frac = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) / 1000 : 0;
  return parseInt(m[1] ?? '0', 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + frac;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '\u200E', rlm: '\u200F' };

/** WebVTT cue text: drop tags (`<i>`, `<c.x>`, `<v Name>`, inline `<00:01.000>`), decode entities. */
function vttText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .trim();
}

function parseVtt(content: string): ParsedCue[] {
  const cues: ParsedCue[] = [];
  for (const block of content.split(/\n{2,}/)) {
    const rows = block.split('\n');
    const timingAt = rows.findIndex((r) => r.includes('-->'));
    // Header, NOTE, STYLE and REGION blocks have no timing line.
    if (timingAt === -1) continue;
    const [from, rest] = rows[timingAt].split('-->');
    const start = toSeconds(from);
    // Cue settings (`align:start line:90%`) follow the end time.
    const end = toSeconds(rest.trim().split(/\s+/)[0] ?? '');
    if (start == null || end == null) continue;
    const text = rows.slice(timingAt + 1).map(vttText).filter(Boolean).join('\n');
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function parseSbv(content: string): ParsedCue[] {
  const cues: ParsedCue[] = [];
  for (const block of content.split(/\n{2,}/)) {
    const rows = block.split('\n');
    const m = rows[0]?.match(/^\s*([\d:.]+)\s*,\s*([\d:.]+)\s*$/);
    if (!m) continue;
    const start = toSeconds(m[1]);
    const end = toSeconds(m[2]);
    const text = rows.slice(1).map((r) => r.trim()).filter(Boolean).join('\n');
    if (start != null && end != null && text) cues.push({ start, end, text });
  }
  return cues;
}

/** ASS event text: drop `{…}` override blocks, `\N`/`\n` are line breaks, `\h` a hard space. */
function assText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
}

function parseAss(content: string): ParsedCue[] {
  const cues: ParsedCue[] = [];
  let inEvents = false;
  // Field order comes from the section's `Format:` line; these are the v4+ defaults.
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  for (const row of content.split('\n')) {
    const line = row.trim();
    if (line.startsWith('[')) { inEvents = line.toLowerCase() === '[events]'; continue; }
    if (!inEvents) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const kind = line.slice(0, colon).trim().toLowerCase();
    const body = line.slice(colon + 1);
    if (kind === 'format') { fields = body.split(',').map((f) => f.trim().toLowerCase()); continue; }
    if (kind !== 'dialogue') continue; // Comment: lines are not shown
    // Text is the last field and may itself contain commas.
    const parts = body.split(',');
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join(',')];
    const get = (name: string) => values[fields.indexOf(name)] ?? '';
    const start = toSeconds(get('start'));
    const end = toSeconds(get('end'));
    const text = assText(get('text'));
    if (start != null && end != null && text) cues.push({ start, end, text });
  }
  // Events are stored in any order; the editor's lines run in time order.
  return cues.sort((a, b) => a.start - b.start);
}

export function parseSubtitleCues(content: string, format: SubtitleImportFormat): ParsedCue[] {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (format === 'vtt') return parseVtt(text);
  if (format === 'sbv') return parseSbv(text);
  return parseAss(text);
}
