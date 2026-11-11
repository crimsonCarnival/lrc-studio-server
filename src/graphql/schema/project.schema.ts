export const projectSchema = `
  "Someone, other than the owner, who edited a project in a collaborative session."
  type ProjectCollaborator {
    "The credit's subject (user:<id> or guest:<id>); pass it to removeProjectCollaborator."
    id: ID!
    "The signed-in collaborator; null for guests. Only id, accountName, displayName and avatarUrl are guaranteed populated; do not select anything else."
    user: User
    "Current display name for users, the typed name for guests."
    name: String!
    isGuest: Boolean!
  }

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
    "What the project is for. Rows from before this field existed read as song."
    kind: ProjectKind!
    readOnly: Boolean
    public: Boolean
    "False on a public project = unlisted: open by link, absent from discovery. Absent means listed."
    listed: Boolean
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
    createdFrom: String
    coverImage: String
    forkedFrom: ForkedFrom
    forkCount: Int
    starCount: Int
    viewCount: Int
    shareCount: Int
    isStarredByMe: Boolean
    isForkedByMe: Boolean
    # How many users shared this project to their profile. Not shareCount, which
    # counts link shares.
    profileShareCount: Int
    isSharedToProfileByMe: Boolean
    "The viewer's own share of this project, null when they have not shared it."
    myProfileShare: ProfileShareNote
    boostCount: Int @deprecated(reason: "Boost became Share to profile; use profileShareCount.")
    isBoostedByMe: Boolean @deprecated(reason: "Use isSharedToProfileByMe.")
    # True when at least one word carries a timestamp (karaoke-style sync).
    hasWordSync: Boolean
    forksEnabled: Boolean
    trendingScore: Float
    "Oldest contribution first. Empty when the viewer cannot read the project."
    collaborators: [ProjectCollaborator!]!
  }

  type ProfileShareItem {
    sharedAt: String!
    description: String!
    tags: [String!]!
    project: Project!
  }

  type ProfileShareNote {
    description: String!
    tags: [String!]!
  }

  "description: up to 500 chars. tags: up to 10, each one word of up to 30 chars; a leading # is dropped."
  input ProfileShareInput {
    description: String
    tags: [String!]
    "On a project already shared: post it again (new date, new feed entry) instead of editing the note."
    reshare: Boolean
  }

  type ProfileSharePage {
    items: [ProfileShareItem!]!
    hasMore: Boolean!
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

  "song: lyrics synced to a track. subtitles: captions timed against a video, edited in the subtitle studio."
  enum ProjectKind {
    song
    subtitles
  }

  input CreateProjectInput {
    title: String
    uploadId: ID
    type: String
    "Set once at creation and never changed. Omitted means song."
    kind: ProjectKind
    readOnly: Boolean
    # @deprecated ignored; projects are always created private. Kept for old and new clients.
    public: Boolean
    metadata: ProjectMetadataInput
    coverImage: String
    state: ProjectStateInput
    lyrics: ProjectLyricsInput
    recaptchaToken: String
    # Attribution for what triggered creation (e.g. "uploads_library"), carried
    # from the ref URL param. Set once at creation; ignored on update.
    createdFrom: String
  }

  input UpdateProjectInput {
    title: String
    uploadId: ID
    public: Boolean
    "With public: true, false makes the project unlisted: anyone with the link can open it, but it is not discoverable. Defaults to listed whenever public changes."
    listed: Boolean
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
