export type CollabRole = 'owner' | 'editor' | 'viewer'

export type CollabMeta = {
  editorMode: 'lrc' | 'srt' | 'words'
  title: string | null
  artist: string | null
  album: string | null
  media: {
    source: 'cloudinary' | 'youtube' | null
    url: string | null
    uploadId: string | null
  }
}
