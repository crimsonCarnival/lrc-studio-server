export const projectSchema = `
  type Project {
    id: ID!
    projectId: String!
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
    lastEditedBy: ID
    expiresAt: String
    createdAt: String
    updatedAt: String
    forkedFrom: ForkedFrom
  }

  type ForkedFrom {
    projectId: String
    userId: ID
    username: String
  }

  type ProjectState {
    syncMode: Boolean
    activeLineIndex: Int
    playbackPosition: Float
    playbackSpeed: Float
    saveTime: String
    timezone: String
    utcOffset: String
  }

  type ProjectMetadata {
    description: String
    tags: [String!]
    songName: String
    songArtist: String
    songAlbum: String
    songYear: String
  }

  input WordInput {
    id: String
    word: String!
    time: Float
    reading: String
  }

  input LineInput {
    id: String
    text: String!
    timestamp: Float
    endTime: Float
    secondary: String
    translation: String
    words: [WordInput!]
    secondaryWords: [WordInput!]
  }

  input ProjectStateInput {
    syncMode: Boolean
    activeLineIndex: Int
    playbackPosition: Float
    playbackSpeed: Float
    saveTime: String
    timezone: String
    utcOffset: String
  }

  input ProjectMetadataInput {
    description: String
    tags: [String!]
    songName: String
    songArtist: String
    songAlbum: String
    songYear: String
  }

  input ProjectLyricsInput {
    editorMode: String
    language: String
    lines: [LineInput!]
    lineIndex: Int
    line: LineInput
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
    state: ProjectStateInput
    lyrics: ProjectLyricsInput
  }
`;
