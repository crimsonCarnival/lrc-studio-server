import { artistKey } from '../artists/artist.service.js'

/** Album grouping and visibility key: NFC + lowercase, whitespace runs collapsed, trimmed. '' = singles. */
export function albumKey(raw: string): string {
  return artistKey(raw.replace(/\s+/g, ' ').trim())
}
import type { GroupedAlbum, GroupedArtist, ShelfRow, VisibilityRow } from './shelf.types.js'

const editedAt = (r: ShelfRow): number => (r.contentUpdatedAt ?? r.updatedAt)?.getTime() ?? 0

const yearOf = (r: ShelfRow): string | null => {
  const y = r.metadata?.songYear
  if (y == null) return null
  const s = String(y).trim()
  return s === '' ? null : s
}

// Years are normally numeric; fall back to string order for odd values.
const compareYears = (a: string, b: string): number => {
  const na = Number(a)
  const nb = Number(b)
  return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b)
}

const byNewest = (a: ShelfRow, b: ShelfRow): number => editedAt(b) - editedAt(a)

export function groupShelf<R extends ShelfRow>(
  rows: R[],
  artistNames: Map<string, string>,
  visibility: VisibilityRow[],
  opts: { visitor: boolean }
): GroupedArtist<R>[] {
  const byArtist = new Map<string, Map<string, R[]>>()
  let skipped = 0

  for (const r of rows) {
    if (r.kind === 'subtitles') continue
    const key = albumKey(r.metadata?.songAlbum ?? '')
    const seen = new Set<string>()
    for (const c of r.metadata?.artists ?? []) {
      if (c.role !== 'primary') continue
      const id = c.artistId == null ? null : String(c.artistId)
      if (id == null || !artistNames.has(id)) {
        skipped++
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      const albums = byArtist.get(id) ?? new Map<string, R[]>()
      byArtist.set(id, albums)
      albums.set(key, [...(albums.get(key) ?? []), r])
    }
  }
  if (skipped > 0) console.warn(`artist-shelf: skipped ${skipped} primary credit(s) without a known artistId`)

  const artistPublic = new Set(visibility.filter(v => v.albumKey === null && v.isPublic).map(v => v.artistId))
  const albumPrivate = new Set(
    visibility.filter(v => v.albumKey !== null && !v.isPublic).map(v => `${v.artistId}\u0000${v.albumKey}`)
  )

  const out: GroupedArtist<R>[] = []
  for (const [id, albumMap] of byArtist) {
    const isPublic = artistPublic.has(id)
    if (opts.visitor && !isPublic) continue

    let albums: GroupedAlbum<R>[] = [...albumMap].map(([key, albumRows]) => {
      const newest = [...albumRows].sort(byNewest)[0]
      const years = albumRows.map(yearOf).filter((y): y is string => y !== null)
      const sorted = [...albumRows].sort((a, b) => {
        const ta = a.metadata?.trackNumber
        const tb = b.metadata?.trackNumber
        if (ta != null && tb != null && ta !== tb) return ta - tb
        if ((ta == null) !== (tb == null)) return ta == null ? 1 : -1
        return (a.title ?? '').localeCompare(b.title ?? '')
      })
      return {
        key,
        title: key === '' ? null : (newest.metadata?.songAlbum ?? '').trim(),
        year: years.length ? years.sort(compareYears).at(-1)! : null,
        isPublic: isPublic && !albumPrivate.has(`${id}\u0000${key}`),
        rows: sorted
      }
    })
    if (opts.visitor) albums = albums.filter(a => a.isPublic)
    if (albums.length === 0) continue

    albums.sort((a, b) => {
      if ((a.key === '') !== (b.key === '')) return a.key === '' ? 1 : -1
      if ((a.year === null) !== (b.year === null)) return a.year === null ? 1 : -1
      if (a.year !== null && b.year !== null && a.year !== b.year) return compareYears(b.year, a.year)
      return (a.title ?? '').localeCompare(b.title ?? '')
    })

    const all = albums.flatMap(a => a.rows)
    const newest = [...all].sort(byNewest)[0]
    out.push({
      id,
      name: artistNames.get(id)!,
      isPublic,
      songCount: all.length,
      albums,
      coverImage: newest.coverImage ?? newest.metadata?.albumArt ?? null,
      latestEditAt: Math.max(0, ...all.map(editedAt))
    })
  }

  return out.sort((a, b) => b.songCount - a.songCount || a.name.localeCompare(b.name))
}
