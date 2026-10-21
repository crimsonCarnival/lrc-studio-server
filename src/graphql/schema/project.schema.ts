export const projectSchema = `
  type Project {
    id: ID!
    publicId: String!
    title: String
    # Readable URL slug derived from artist + song name (else title); may be empty.
    slug: String!
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
    # When the project's content (lyrics, title/metadata, cover, media) last
    # changed. Unlike updatedAt it ignores editor-state saves, counters and
    # maintenance writes. Null on rows last written before this field existed.
    contentUpdatedAt: String
    coverImage: String
    forkedFrom: ForkedFrom
    forkCount: Int
    starCount: Int
    viewCount: Int
    shareCount: Int
    isStarredByMe: Boolean
    isForkedByMe: Boolean
    boostCount: Int
    isBoostedByMe: Boolean
    # True when at least one word carries a timestamp (karaoke-style sync).
    hasWordSync: Boolean
    forksEnabled: Boolean
    trendingScore: Float
  }

  type ForkedFrom {
    publicId: String
    userId: ID
    accountName: String
    sourceDeleted: Boolean
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
    singerColors: [String!]
    singers: [String!]
    songName: String
    # Derived from artists, e.g. "Drake feat. Rihanna". Read-only: not accepted as input.
    songArtist: String
    artists: [ArtistCredit!]!
    songAlbum: String
    songYear: String
    songGenre: String
    songLanguage: String
    trackNumber: Int
    trackCount: Int
    albumArt: String
    previewUrl: String
    explicit: Boolean
  }

  enum ArtistRole {
    primary
    featured
  }

  type ArtistCredit {
    # The owner's artist record; null on legacy credits.
    artistId: ID
    name: String!
    role: ArtistRole!
    order: Int!
  }

  input ArtistCreditInput {
    name: String!
    role: ArtistRole!
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
    adLibOf: Float
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
    singerColors: [String!]
    singers: [String!]
    songName: String
    # Omit to leave the artists as they are; [] clears them. Order in the list is the display order.
    artists: [ArtistCreditInput!]
    songAlbum: String
    songYear: String
    songGenre: String
    songLanguage: String
    trackNumber: Int
    trackCount: Int
    albumArt: String
    previewUrl: String
    explicit: Boolean
  }

  # One positional line write within a multi-line patch (see ProjectLyricsInput.lines).
  input LinePatchInput {
    sectionIdx: Int!
    lineIdx: Int!
    line: LineInput!
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
    # Positional multi-line patch: several lines changed in one save, line
    # count and section markers both unchanged. Additive alongside the
    # single-line and full-sections shapes above — a client that doesn't
    # send this still works exactly as before.
    lines: [LinePatchInput!]
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
    # Explicit user save vs autosave (omitted = autosave). Intent only: the
    # server decides from persisted state whether the save changed anything.
    saveKind: SaveKind
  }

  enum SaveKind {
    manual
    auto
  }

  """
  Outcome of registering a view. \`counted\` is false when the view was seen but
  deliberately not counted — the viewer already counted today, is the owner, the
  project is private, or the caller had no stable identity.
  """
  type ProjectViewResult {
    counted: Boolean!
    viewCount: Int!
  }
`;
