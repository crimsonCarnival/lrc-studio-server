export type ShelfRow = {
  _id: unknown
  publicId: string
  kind?: string | null
  coverImage?: string | null
  contentUpdatedAt?: Date | null
  updatedAt?: Date | null
  title?: string | null
  metadata?: {
    artists?: { name: string; role: 'primary' | 'featured'; artistId?: unknown }[] | null
    songAlbum?: string | null
    songYear?: string | number | null
    trackNumber?: number | null
    albumArt?: string | null
  } | null
}

export type VisibilityRow = { artistId: string; albumKey: string | null; isPublic: boolean }

export type GroupedAlbum<R> = {
  key: string
  title: string | null
  year: string | null
  isPublic: boolean
  rows: R[]
}

export type GroupedArtist<R> = {
  id: string
  name: string
  isPublic: boolean
  songCount: number
  albums: GroupedAlbum<R>[]
  coverImage: string | null
  latestEditAt: number
}
