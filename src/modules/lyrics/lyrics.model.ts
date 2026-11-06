import mongoose from 'mongoose';
import { stripHtml } from '../../utils/sanitize.js';
import type { LineEntry, SectionEntry } from '../../types/index.js';

const textSetter = (v: string) => (typeof v === 'string' ? stripHtml(v) : v);

/**
 * Upper bound for any timestamp, end time or word time, in seconds. Sync minutes,
 * XP and the leaderboard are derived from these values, so an unbounded one lets
 * a single save set any level. 6 h is an assumption: longer than any song or mix
 * the editor is meant for. Raise it here if a legitimate case needs more.
 */
export const MAX_TIME_SECONDS = 6 * 3600;

const timeField = { type: Number, default: null, min: 0, max: MAX_TIME_SECONDS };

/** Throws 422 unless `value` is null/undefined or a finite number in [0, MAX_TIME_SECONDS]. */
export function assertTimeInRange(value: unknown, context: string): void {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIME_SECONDS) {
    throw Object.assign(new Error(`${context}: time must be between 0 and ${MAX_TIME_SECONDS} seconds`), { statusCode: 422 });
  }
}

/** Range-checks every time field of a line (timestamp, endTime, counterpart anchor, word times). */
export function assertLineTimesInRange(line: unknown, context: string): void {
  const l = line as { timestamp?: unknown; endTime?: unknown; adLibOf?: unknown; words?: unknown; secondaryWords?: unknown } | null;
  if (!l || typeof l !== 'object') return;
  assertTimeInRange(l.timestamp, context);
  assertTimeInRange(l.endTime, context);
  assertTimeInRange(l.adLibOf, context);
  for (const list of [l.words, l.secondaryWords]) {
    if (Array.isArray(list)) for (const w of list) assertTimeInRange((w as { time?: unknown } | null)?.time, context);
  }
}

// --- Subdocument: Word ---
const wordSchema = new mongoose.Schema(
  {
    word: { type: String, default: '', maxlength: 500, set: textSetter },
    time: timeField,
    reading: { type: String, default: '', maxlength: 500, set: textSetter },
    singerIndex: { type: Number, default: null, min: 0 },
  },
  { _id: false }
);

// --- Subdocument: Translation ---
const translationSchema = new mongoose.Schema(
  {
    language: { type: String, default: '', maxlength: 50 },
    text: { type: String, default: '', maxlength: 2000, set: textSetter },
  },
  { _id: false }
);

// --- Subdocument: Line (within a section) ---
const lineSchema = new mongoose.Schema(
  {
    id: { type: String, default: null, maxlength: 50 },
    text: { type: String, default: '', maxlength: 2000, set: textSetter },
    timestamp: timeField,
    endTime: timeField,
    secondary: { type: String, default: null, maxlength: 2000, set: textSetter },
    singers: { type: [String], default: undefined },
    mode: { type: String, enum: ['solo', 'duet', 'split'], default: null },
    translation: { type: String, default: null, maxlength: 2000, set: textSetter },
    translations: { type: [translationSchema], default: undefined },
    words: { type: [wordSchema], default: undefined },
    secondaryWords: { type: [wordSchema], default: undefined },
    // Who set the timing: 'manual', 'asr' (auto-stamp), 'import' (parsed from a file or lyrics search)
    // or 'fork' (copied by cloning). null = legacy/unknown (treated as manual). Becomes 'manual' when
    // the user re-times the line. Weighted in sync stats, see badges/sync-stats.ts.
    source: { type: String, enum: ['manual', 'asr', 'import', 'fork'], default: null },
    // Counterpart anchor (named for the feature's old "ad-lib" name): when set, this line
    // overlaps the parent line at timestamp=adLibOf.
    adLibOf: timeField,
  },
  { _id: false }
);


// --- Subdocument: Section ---
const sectionSchema = new mongoose.Schema(
  {
    label: { type: String, default: null, maxlength: 500, set: textSetter },
    depth: { type: Number, default: null, min: 0, max: 1 },
    id: { type: String, default: null, maxlength: 50 },
    // Singers available for lines within this section.
    singers: { type: [String], default: undefined },
    // Optional section-level timestamp (e.g. karaoke highlight cue).
    timestamp: timeField,
    lines: { type: [lineSchema], default: [] },
  },
  { _id: false }
);

// --- Main: Lyrics ---
const lyricsSchema = new mongoose.Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    editorMode: {
      type: String,
      enum: ['lrc', 'srt', 'words'],
      default: 'lrc',
    },
    sections: { type: [sectionSchema], default: [] },
    // Kept for lazy migration of pre-sections documents — removed on first write.
    lines: { type: mongoose.Schema.Types.Mixed, default: undefined, select: false },

    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'lyrics' }
);

lyricsSchema.index({ updatedAt: -1 });

lyricsSchema.pre('validate', function () {
  for (const section of this.sections ?? []) {
    for (let i = 0; i < (section.lines ?? []).length; i++) {
      const line = section.lines[i];
      if (line.timestamp != null && line.endTime != null && line.endTime <= line.timestamp) {
        throw new Error(`Section line ${i}: endTime must be greater than timestamp`);
      }
    }
  }
});

lyricsSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = obj._id?.toString();
  delete obj.__v;
  delete obj._id;
  delete obj.lines; // never expose the deprecated migration field
  return obj;
};

// ── Migration helpers ──────────────────────────────────────────────────────

export function migrateLinesToSections(lines: LineEntry[]): SectionEntry[] {
  if (!lines?.length) return [];
  const sections: SectionEntry[] = [];
  let current: SectionEntry | null = null;

  for (const line of lines) {
    if ((line as { type?: string }).type === 'section') {
      if (current) sections.push(current);
      current = {
        label: (line as { label?: string | null }).label ?? null,
        depth: (line as { depth?: number | null }).depth ?? null,
        id: (line as { id?: string | null }).id ?? null,
        singers: Array.isArray((line as { singers?: string[] }).singers) ? (line as { singers: string[] }).singers : undefined,
        timestamp: typeof line.timestamp === 'number' ? line.timestamp : null,
        lines: [],
      };
    } else {
      if (!current) current = { label: null, depth: null, id: null, singers: undefined, timestamp: null, lines: [] };
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function sectionsToFlatLines(sections: SectionEntry[]): LineEntry[] {
  const flat: LineEntry[] = [];
  for (const sec of sections ?? []) {
    flat.push({ type: 'section', label: sec.label, depth: sec.depth, id: sec.id, singers: sec.singers, timestamp: sec.timestamp ?? null, text: '' } as LineEntry);
    for (const line of sec.lines ?? []) {
      flat.push(line);
    }
  }
  return flat;
}

export default mongoose.model('Lyrics', lyricsSchema);
