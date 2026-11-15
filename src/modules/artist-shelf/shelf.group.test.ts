import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { albumKey, groupShelf } from './shelf.group.js'
import type { ShelfRow, VisibilityRow } from './shelf.types.js'

type Credit = { name: string; role: 'primary' | 'featured'; artistId?: unknown }

let n = 0
const row = (
  title: string,
  artists: Credit[],
  opts: {
    album?: string | null
    year?: string | number | null
    track?: number | null
    kind?: string
    edited?: string
    cover?: string | null
    albumArt?: string | null
  } = {}
): ShelfRow => ({
  _id: `r${++n}`,
  publicId: `p${n}`,
  kind: opts.kind,
  title,
  coverImage: opts.cover ?? null,
  contentUpdatedAt: opts.edited ? new Date(opts.edited) : null,
  updatedAt: new Date('2026-01-01'),
  metadata: {
    artists,
    songAlbum: opts.album ?? null,
    songYear: opts.year ?? null,
    trackNumber: opts.track ?? null,
    albumArt: opts.albumArt ?? null
  }
})

const A = (id = 'a1', role: 'primary' | 'featured' = 'primary'): Credit => ({ name: id, role, artistId: id })
const names = new Map([
  ['a1', 'Kanye'],
  ['a2', 'Jay'],
  ['a3', 'Zed']
])
const pub = (artistId: string, albumKey: string | null, isPublic = true): VisibilityRow => ({
  artistId,
  albumKey,
  isPublic
})
const owner = { visitor: false }
const visitor = { visitor: true }

describe('groupShelf', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('groups primaries only, ignoring featured', () => {
    const out = groupShelf([row('s', [A('a1'), A('a2', 'featured')])], names, [], owner)
    expect(out.map(a => a.id)).toEqual(['a1'])
  })

  it('a song with two primaries appears under both and counts once each', () => {
    const out = groupShelf([row('s', [A('a1'), A('a2')])], names, [], owner)
    expect(out.map(a => [a.id, a.songCount])).toEqual([
      ['a2', 1],
      ['a1', 1]
    ])
    expect(out.every(a => a.albums[0].rows.length === 1)).toBe(true)
  })

  it('skips a primary credit without artistId', () => {
    const out = groupShelf(
      [row('s', [{ name: 'Ghost', role: 'primary' }, A('a1')]), row('t', [{ name: 'Ghost', role: 'primary' }])],
      names,
      [],
      owner
    )
    expect(out.map(a => a.id)).toEqual(['a1'])
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(console.warn).mock.calls[0].join(' '))).not.toContain('Ghost')
  })

  it('merges album spellings by key and titles with the newest spelling', () => {
    const out = groupShelf(
      [
        row('a', [A()], { album: 'Graduation', edited: '2026-01-01' }),
        row('b', [A()], { album: 'graduation ', edited: '2026-01-02' })
      ],
      names,
      [],
      owner
    )
    expect(out[0].albums).toHaveLength(1)
    expect(out[0].albums[0].title).toBe('graduation')
    expect(out[0].albums[0].key).toBe('graduation')
    expect(out[0].albums[0].rows).toHaveLength(2)
  })

  it('merges album names that differ only in inner whitespace', () => {
    const out = groupShelf(
      [
        row('a', [A()], { album: 'Small  Hours', edited: '2026-01-01' }),
        row('b', [A()], { album: 'Small Hours', edited: '2026-01-02' })
      ],
      names,
      [],
      owner
    )
    expect(out[0].albums).toHaveLength(1)
    expect(out[0].albums[0].key).toBe('small hours')
  })

  it('albumKey collapses whitespace, trims and lowercases', () => {
    expect(albumKey('  Small \t  Hours ')).toBe('small hours')
    expect(albumKey('')).toBe('')
  })

  it("empty album goes to the '' bucket, ordered last", () => {
    const out = groupShelf(
      [
        row('a', [A()], { album: null, year: 2020 }),
        row('b', [A()], { album: 'Zzz', year: 1999 })
      ],
      names,
      [],
      owner
    )
    expect(out[0].albums.map(a => [a.key, a.title])).toEqual([
      ['zzz', 'Zzz'],
      ['', null]
    ])
  })

  it('excludes subtitles projects', () => {
    const out = groupShelf([row('s', [A()], { kind: 'subtitles' }), row('t', [A()], { kind: 'song' })], names, [], owner)
    expect(out[0].songCount).toBe(1)
  })

  it('defaults to private with no visibility rows', () => {
    const out = groupShelf([row('s', [A()], { album: 'X' })], names, [], owner)
    expect(out[0].isPublic).toBe(false)
    expect(out[0].albums[0].isPublic).toBe(false)
  })

  it('album override false hides only that album for visitors', () => {
    const rows = [row('s', [A()], { album: 'X' }), row('t', [A()], { album: 'Y' })]
    const vis = [pub('a1', null), pub('a1', 'x', false)]
    const out = groupShelf(rows, names, vis, visitor)
    expect(out[0].albums.map(a => a.key)).toEqual(['y'])
    expect(out[0].songCount).toBe(1)
    const own = groupShelf(rows, names, vis, owner)
    expect(own[0].albums.map(a => [a.key, a.isPublic])).toEqual([
      ['x', false],
      ['y', true]
    ])
  })

  it('an album row stored under an older key form still hides the album', () => {
    const rows = [row('s', [A()], { album: 'Small  Hours' }), row('t', [A()], { album: 'Y' })]
    const vis = [pub('a1', null), pub('a1', 'small  hours', false)]
    expect(groupShelf(rows, names, vis, visitor)[0].albums.map(a => a.key)).toEqual(['y'])
  })

  it('private artist hides its albums even with album rows public', () => {
    const rows = [row('s', [A()], { album: 'X' })]
    const vis = [pub('a1', 'x', true)]
    expect(groupShelf(rows, names, vis, visitor)).toEqual([])
    expect(groupShelf(rows, names, vis, owner)[0].albums[0].isPublic).toBe(false)
  })

  it('visitor mode drops empty artists', () => {
    const rows = [row('s', [A('a1')], { album: 'X' }), row('t', [A('a2')], { album: 'Y' })]
    const vis = [pub('a1', null), pub('a2', null), pub('a2', 'y', false)]
    const out = groupShelf(rows, names, vis, visitor)
    expect(out.map(a => a.id)).toEqual(['a1'])
  })

  it('orders artists by songCount then name, rows by trackNumber', () => {
    const rows = [
      row('c', [A('a1')], { album: 'X', track: null }),
      row('b', [A('a1')], { album: 'X', track: 2 }),
      row('a', [A('a1')], { album: 'X', track: 1 }),
      row('s', [A('a3')]),
      row('t', [A('a2')])
    ]
    const out = groupShelf(rows, names, [], owner)
    expect(out.map(a => a.id)).toEqual(['a1', 'a2', 'a3'])
    expect(out[0].albums[0].rows.map(r => r.title)).toEqual(['a', 'b', 'c'])
  })

  it('orders albums by year desc, takes max year, newest cover and latest edit', () => {
    const rows = [
      row('a', [A()], { album: 'Old', year: '2001', cover: 'c1', edited: '2026-02-01' }),
      row('b', [A()], { album: 'New', year: 2010, albumArt: 'art', edited: '2026-03-01' }),
      row('c', [A()], { album: 'New', year: 2012, edited: '2026-01-15' })
    ]
    const out = groupShelf(rows, names, [], owner)[0]
    expect(out.albums.map(a => [a.key, a.year])).toEqual([
      ['new', '2012'],
      ['old', '2001']
    ])
    expect(out.coverImage).toBe('art')
    expect(out.latestEditAt).toBe(new Date('2026-03-01').getTime())
  })

  it('treats an artistId missing from the name map like a missing artistId', () => {
    const out = groupShelf([row('s', [A('zzz')])], names, [], owner)
    expect(out).toEqual([])
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
