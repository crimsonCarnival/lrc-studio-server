import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { docToMeta, docToSections, sanitizeSectionsForLyrics, seedDocFromProject } from './collab.projection.js'
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
  it('a line map without order sorts as empty order, tie-broken by id', () => {
    const doc = new Y.Doc()
    const lines = doc.getMap<Y.Map<unknown>>('lines')
    const put = (id: string, order?: unknown) => {
      const m = new Y.Map<unknown>()
      m.set('id', id)
      m.set('text', id)
      if (order !== undefined) m.set('order', order)
      lines.set(id, m)
    }
    put('y', 'a0')
    put('x')
    put('w')
    put('v', 42)
    const flat = (docToSections(doc) as typeof sections).flatMap((s) => s.lines.map((l) => l.id))
    expect(flat).toEqual(['v', 'w', 'x', 'y'])
  })
})

describe('sanitizeSectionsForLyrics', () => {
  const long = (n: number) => 'x'.repeat(n)

  it('truncates over-long strings to the lineSchema limits', () => {
    const [sec] = sanitizeSectionsForLyrics([{
      label: long(600), id: 's', depth: 0, lines: [{
        id: 'a', text: long(2500), secondary: long(2100), translation: long(2100), timestamp: 1,
        translations: [{ text: long(2100), language: long(60) }],
        words: [{ word: long(600), time: 1, reading: long(600) }],
      }],
    }])
    const line = sec.lines[0]
    expect(sec.label).toHaveLength(500)
    expect(line.text).toHaveLength(2000)
    expect(line.secondary).toHaveLength(2000)
    expect(line.translation).toHaveLength(2000)
    expect(line.translations![0].text).toHaveLength(2000)
    expect(line.translations![0].language).toHaveLength(50)
    expect(line.words![0].word).toHaveLength(500)
    expect(line.words![0].reading).toHaveLength(500)
  })

  it('nulls ids longer than the schema allows instead of truncating them into collisions', () => {
    const [sec] = sanitizeSectionsForLyrics([{ id: long(55), lines: [{ id: long(51), text: 'a' }, { id: long(50), text: 'b' }] }])
    expect(sec.id).toBeNull()
    expect(sec.lines.map((l) => l.id)).toEqual([null, long(50)])
  })

  it('drops lines and words of the wrong shape and coerces wrong-typed fields', () => {
    const [sec] = sanitizeSectionsForLyrics([{
      lines: [
        'not a line', null, 42,
        {
          id: 'a', text: 7, timestamp: '3', endTime: Number.NaN, mode: 'trio', source: 'robot', adLibOf: 'x',
          singers: ['A', 3, 'B'], words: 'nope', secondaryWords: [{ word: 'ok', time: 'soon', singerIndex: -1 }, { time: 2 }, 'w'],
          translations: [{ text: 'hola', language: 'es' }, 'bad', { language: 'fr' }],
        },
      ],
    }])
    expect(sec.lines).toHaveLength(1)
    const line = sec.lines[0]
    expect(line).toMatchObject({ id: 'a', text: '', timestamp: null, endTime: null, mode: null, source: null, adLibOf: null })
    expect(line.singers).toEqual(['A', 'B'])
    expect(line.words).toBeUndefined()
    expect(line.secondaryWords).toEqual([{ word: 'ok', time: null }])
    expect(line.translations).toEqual([{ text: 'hola', language: 'es' }])
  })

  it('drops sections of the wrong shape and keeps depth within 0..1', () => {
    const out = sanitizeSectionsForLyrics(['x', { depth: 5, lines: 'no' }, { depth: 1, lines: [] }])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ depth: null, lines: [] })
    expect(out[1]).toMatchObject({ depth: 1 })
  })

  it('passes a well-formed project through unchanged', () => {
    const doc = new Y.Doc()
    seedDocFromProject(doc, structuredClone(sections), meta)
    expect(sanitizeSectionsForLyrics(docToSections(doc))).toEqual(docToSections(doc))
  })
})
