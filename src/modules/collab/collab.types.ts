export type CollabRole = 'owner' | 'editor' | 'viewer'

export type CollabMeta = {
  editorMode: 'lrc' | 'srt' | 'words'
  title: string | null
  artist: string | null
  album: string | null
  /** The project's cover image URL. Seeded and synced from the Project, never written back. */
  cover: string | null
  media: {
    source: 'cloudinary' | 'youtube' | null
    url: string | null
    uploadId: string | null
  }
}
