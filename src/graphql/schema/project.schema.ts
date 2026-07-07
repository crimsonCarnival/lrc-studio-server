export const projectSchema = `
  type Project {
    id: ID!
    publicId: String!
    title: String
    user: User
    upload: Upload
    lyrics: Lyrics
    state: ProjectState
    metadata: ProjectMetadata
    type: String
    readOnly: Boolean
    public: Boolean
    lineCount: Int
    syncedLineCount: Int
    userId: ID
    uploadId: ID
    lyricsId: ID
    expiresAt: String
    createdAt: String
    updatedAt: String
    coverImage: String
    forkedFrom: ForkedFrom
    forkCount: Int
    starCount: Int
    isStarredByMe: Boolean
    isForkedByMe: Boolean
    forksEnabled: Boolean
    trendingScore: Float
  }

  type ForkedFrom {
    publicId: String
    userId: ID
    accountName: String
  }

  type ProjectState {
    syncMode: Boolean
    activeLineIndex: Int
    playbackPosition: Float
    playbackSpeed: Float
    saveTime: String
  }

  type ProjectMetadata {
    description: String
    genre: String
    tags: [String!]
    songName: String
    songArtist: String
    songAlbum: String
    songYear: String
    songGenre: String
    songLanguage: String
    trackNumber: Int
    trackCount: Int
    albumArt: String
  }

  input WordInput {
    id: String
    word: String!
    time: Float
    reading: String
    singerIndex: Int
  }

  input TranslationInput {
    language: String!
    text: String!
  }

  input LineInput {
    id: String
    type: String
    label: String
    depth: Int
    text: String
    timestamp: Float
    endTime: Float
    secondary: String
    singers: [String!]
    mode: String
    translation: String
    translations: [TranslationInput!]
    words: [WordInput!]
    secondaryWords: [WordInput!]
    source: String
  }

  input ProjectStateInput {
    syncMode: Boolean
    activeLineIndex: Int
    playbackPosition: Float
    playbackSpeed: Float
    saveTime: String
  }

  input ProjectMetadataInput {
    description: String
    genre: String
    tags: [String!]
    songName: String
    songArtist: String
    songAlbum: String
    songYear: String
    songGenre: String
    songLanguage: String
    trackNumber: Int
    trackCount: Int
    albumArt: String
  }

  input ProjectLyricsInput {
    editorMode: String
    language: String
    # Full sections replace
    sections: [SectionInput!]
    # Positional single-line patch
    sectionIdx: Int
    lineIdx: Int
    line: LineInput
    # Positional word patch
    wordIndex: Int
    word: WordInput
  }

  input CreateProjectInput {
    title: String
    uploadId: ID
    type: String
    readOnly: Boolean
    public: Boolean
    metadata: ProjectMetadataInput
    coverImage: String
    state: ProjectStateInput
    lyrics: ProjectLyricsInput
    recaptchaToken: String
  }

  input UpdateProjectInput {
    title: String
    uploadId: ID
    public: Boolean
    readOnly: Boolean
    version: Int
    metadata: ProjectMetadataInput
    coverImage: String
    state: ProjectStateInput
    lyrics: ProjectLyricsInput
  }
`;
