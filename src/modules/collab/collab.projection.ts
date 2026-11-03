import { nanoid } from 'nanoid'
import { generateNKeysBetween } from 'fractional-indexing'
import * as Y from 'yjs'
import { migrateLinesToSections, sectionsToFlatLines } from '../lyrics/lyrics.model.js'
import type { LineEntry, SectionEntry } from '../../types/index.js'
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
