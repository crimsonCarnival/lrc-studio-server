import { nanoid } from 'nanoid'
import { generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import { migrateLinesToSections, sectionsToFlatLines } from '../lyrics/lyrics.model.js'
import { MAX_SINGER_NAME_LENGTH } from '../projects/project.model.js'
import type { LineEntry, SectionEntry, WordEntry } from '../../types/index.js'
import type { CollabMeta } from './collab.types.js'

// Fields stored per line Y.Map: the shared schema's list plus the remaining fields
// Lyrics.lineSchema persists (translation, adLibOf), so a round trip never drops data.
const LINE_FIELDS = [
  'text', 'timestamp', 'endTime', 'secondary', 'translation', 'translations', 'words',
  'secondaryWords', 'type', 'label', 'depth', 'singers', 'mode', 'source', 'confidence', 'adLibOf',
] as const

const META_FIELDS = ['editorMode', 'title', 'artist', 'album', 'media'] as const

export function seedDocFromProject(doc: Y.Doc, sections: unknown[], meta: CollabMeta): void {
  const secs = sections as SectionEntry[]
  // An unlabeled, id-less first section is the "lines before the first marker" bucket:
  // it has no marker line in flat form.
  const [first, ...rest] = secs
  const anonymousFirst = first && first.id == null && first.label == null
  const flat = anonymousFirst
    ? [...(first.lines ?? []), ...sectionsToFlatLines(rest)]
    : sectionsToFlatLines(secs)

  doc.transact(() => {
    const lines = doc.getMap<Y.Map<unknown>>('lines')
    const orders = generateNKeysBetween(null, null, flat.length)
    flat.forEach((line, i) => {
      const src = line as unknown as Record<string, unknown>
      let id = typeof src.id === 'string' && src.id ? src.id : nanoid(10)
      while (lines.has(id)) id = nanoid(10)
      const m = new Y.Map<unknown>()
      m.set('id', id)
      m.set('order', orders[i])
      for (const f of LINE_FIELDS) if (src[f] !== undefined) m.set(f, src[f])
      lines.set(id, m)
    })
    const metaMap = doc.getMap<unknown>('meta')
    for (const f of META_FIELDS) metaMap.set(f, meta[f])
  })
}

export function docToSections(doc: Y.Doc): unknown[] {
  const flat = [...doc.getMap<Y.Map<unknown>>('lines').values()]
    .map((m) => m.toJSON() as Record<string, unknown>)
    // A line map with a missing or non-string `order` (a buggy or hostile client)
    // sorts as '' so the comparator stays a total order; id breaks every tie.
    .sort((a, b) => {
      const ao = typeof a.order === 'string' ? a.order : ''
      const bo = typeof b.order === 'string' ? b.order : ''
      if (ao !== bo) return ao < bo ? -1 : 1
      const ai = String(a.id ?? '')
      const bi = String(b.id ?? '')
      return ai < bi ? -1 : ai > bi ? 1 : 0
    })
    .map(({ order: _order, ...line }) => line as unknown as LineEntry)
  return migrateLinesToSections(flat)
}

export function docToMeta(doc: Y.Doc): CollabMeta {
  const m = doc.getMap<unknown>('meta')
  const media = (m.get('media') as CollabMeta['media'] | undefined) ?? { source: null, url: null, uploadId: null }
  return {
    editorMode: (m.get('editorMode') as CollabMeta['editorMode'] | undefined) ?? 'lrc',
    title: (m.get('title') as string | null | undefined) ?? null,
    artist: (m.get('artist') as string | null | undefined) ?? null,
    album: (m.get('album') as string | null | undefined) ?? null,
    media,
  }
}

// Limits mirror Lyrics.lineSchema / sectionSchema / wordSchema / translationSchema
// (modules/lyrics/lyrics.model.ts). Keep them in step with that file.
// lineSchema.singers has no maxlength of its own; singer names come from the project
// roster, capped at MAX_SINGER_NAME_LENGTH (mirrored client-side in SingersInput.tsx).
const LIMITS = { id: 50, text: 2000, label: 500, word: 500, language: 50, singer: MAX_SINGER_NAME_LENGTH } as const
const LINE_MODES = new Set(['solo', 'duet', 'split'])
const LINE_SOURCES = new Set(['manual', 'asr'])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const clip = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
// An over-long id is dropped, not truncated: two truncated ids could collide.
const idOf = (v: unknown): string | null => (typeof v === 'string' && v.length <= LIMITS.id ? v : null)
const singersOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, LIMITS.singer)) : undefined

function wordsOf(v: unknown): WordEntry[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v
    .filter((w): w is Obj => isObj(w) && typeof w.word === 'string')
    .map((w) => {
      const out: WordEntry = { word: (w.word as string).slice(0, LIMITS.word), time: finite(w.time) }
      if (typeof w.reading === 'string') out.reading = w.reading.slice(0, LIMITS.word)
      if (typeof w.singerIndex === 'number' && Number.isInteger(w.singerIndex) && w.singerIndex >= 0) out.singerIndex = w.singerIndex
      return out
    })
}

function lineOf(l: Obj): LineEntry {
  const out: Record<string, unknown> = { text: clip(l.text, LIMITS.text) ?? '' }
  const has = (k: string) => l[k] !== undefined
  if (has('id')) out.id = idOf(l.id)
  if (has('timestamp')) out.timestamp = finite(l.timestamp)
  if (has('endTime')) out.endTime = finite(l.endTime)
  if (has('secondary')) out.secondary = clip(l.secondary, LIMITS.text)
  if (has('translation')) out.translation = clip(l.translation, LIMITS.text)
  if (has('singers')) out.singers = singersOf(l.singers)
  if (has('mode')) out.mode = typeof l.mode === 'string' && LINE_MODES.has(l.mode) ? l.mode : null
  if (has('source')) out.source = typeof l.source === 'string' && LINE_SOURCES.has(l.source) ? l.source : null
  if (has('adLibOf')) out.adLibOf = finite(l.adLibOf)
  if (has('words')) out.words = wordsOf(l.words)
  if (has('secondaryWords')) out.secondaryWords = wordsOf(l.secondaryWords)
  if (has('translations')) {
    out.translations = Array.isArray(l.translations)
      ? l.translations
        .filter((t): t is Obj => isObj(t) && typeof t.text === 'string')
        .map((t) => ({ text: (t.text as string).slice(0, LIMITS.text), language: clip(t.language, LIMITS.language) ?? '' }))
      : undefined
  }
  return out as unknown as LineEntry
}

/**
 * Makes doc-derived sections safe to $set into Lyrics. The Y.Doc accepts any
 * value a collaborator writes, while Lyrics validates (runValidators) — so one
 * over-long string or wrong-typed field would otherwise fail every projection
 * until someone edited it away. Values are clipped/coerced to the schema, and
 * lines, words and sections of the wrong shape are dropped.
 */
export function sanitizeSectionsForLyrics(sections: unknown[]): SectionEntry[] {
  return sections.filter(isObj).map((s) => ({
    label: clip(s.label, LIMITS.label),
    depth: s.depth === 0 || s.depth === 1 ? s.depth : null,
    id: idOf(s.id),
    singers: singersOf(s.singers),
    timestamp: finite(s.timestamp),
    lines: Array.isArray(s.lines) ? s.lines.filter(isObj).map(lineOf) : [],
  }))
}

const EDITOR_MODES = new Set<string>(['lrc', 'srt', 'words'])
/** The doc's editorMode if it is one Lyrics accepts, else null (keep the stored one). */
export function validEditorMode(v: unknown): CollabMeta['editorMode'] | null {
  return typeof v === 'string' && EDITOR_MODES.has(v) ? (v as CollabMeta['editorMode']) : null
}
