import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { docToMeta, docToSections, seedDocFromProject } from './collab.projection.js'
import type { CollabMeta } from './collab.types.js'

const meta: CollabMeta = {
  editorMode: 'srt',
  title: 'Song',
  artist: 'Artist',
  album: null,
  media: { source: 'youtube', url: 'https://youtu.be/x', uploadId: null },
}

const sections = [
  {
    label: null,
    depth: null,
    id: null,
    singers: undefined,
    timestamp: null,
    lines: [{ id: 'a', text: 'intro', timestamp: 1, endTime: 2.5 }],
  },
  {
    label: 'Chorus',
    depth: 0,
    id: 's1',
    singers: ['A', 'B'],
    timestamp: 10,
    lines: [
      {
        id: 'b',
        text: 'hello world',
        timestamp: 10,
        endTime: 12,
        secondary: 'hola',
        mode: 'duet',
        translations: [{ text: 'hola mundo', language: 'es' }],
        words: [
          { word: 'hello', time: 10, reading: '', singerIndex: 0 },
          { word: 'world', time: 11, reading: '', singerIndex: 1 },
        ],
        source: 'asr',
      },
      { id: 'c', text: 'again', timestamp: null },
    ],
  },
]

describe('collab projection', () => {
  it('seed -> docToSections round-trips section markers, srt endTimes and words', () => {
    const doc = new Y.Doc()
    seedDocFromProject(doc, structuredClone(sections), meta)
    expect(docToSections(doc)).toEqual(sections)
    expect(docToMeta(doc)).toEqual(meta)
  })

  it('lines without id get a stable id on seed', () => {
    const doc = new Y.Doc()
    seedDocFromProject(doc, [{ label: null, lines: [{ text: 'x', timestamp: null }, { text: 'y', timestamp: null }] }], meta)
    const first = docToSections(doc) as typeof sections
    const ids = first[0].lines.map((l) => l.id)
    expect(ids.every((i) => typeof i === 'string' && i.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect((docToSections(doc) as typeof sections)[0].lines.map((l) => l.id)).toEqual(ids)
  })

  it('order keys sort to the original order', () => {
    const doc = new Y.Doc()
    seedDocFromProject(doc, structuredClone(sections), meta)
    const orders = [...doc.getMap<Y.Map<unknown>>('lines').values()]
      .map((m) => ({ id: m.get('id') as string, order: m.get('order') as string }))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
      .map((x) => x.id)
    expect(orders).toEqual(['a', 's1', 'b', 'c'])
  })

  it('two docs that concurrently move the same line converge with one copy', () => {
    const a = new Y.Doc()
    seedDocFromProject(a, structuredClone(sections), meta)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    a.getMap<Y.Map<unknown>>('lines').get('c')!.set('order', 'a0')
    b.getMap<Y.Map<unknown>>('lines').get('c')!.set('order', 'zz')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    expect(a.getMap('lines').size).toBe(4)
    expect(b.getMap('lines').size).toBe(4)
    expect(docToSections(a)).toEqual(docToSections(b))
  })
})
