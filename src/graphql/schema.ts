export const schema = `
  type User {
    id: ID!
    username: String
    email: String
    avatarUrl: String
    bio: String
    isVerified: Boolean!
    isBanned: Boolean!
    bannedUntil: String
    banReason: String
    appealStatus: String
    banAppeal: String
    showUnbanMessage: Boolean
    role: String!
    createdAt: String
    spotify: SpotifyInfo
    projects: [Project!]!
    uploads: [Upload!]!
    settings: Settings
  }

  type SpotifyInfo {
    connected: Boolean!
    spotifyId: String
    isPremium: Boolean!
    profilePictureUrl: String
  }

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
    lastEditedBy: ID
    expiresAt: String
    createdAt: String
    updatedAt: String
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
  }

  type Lyrics {
    id: ID!
    projectId: String!
    editorMode: String!
    language: String
    lines: [Line!]!
    version: Int
    createdAt: String
    updatedAt: String
  }

  type Line {
    text: String!
    timestamp: Float
    endTime: Float
    secondary: String
    translation: String
    words: [Word!]
    secondaryWords: [SecondaryWord!]
  }

  type Word {
    word: String!
    time: Float
    reading: String
  }

  type SecondaryWord {
    word: String!
    time: Float
  }

  type Upload {
    id: ID!
    source: String!
    cloudinaryUrl: String
    publicId: String
    youtubeUrl: String
    spotifyTrackId: String
    artist: String
    fileName: String!
    title: String!
    duration: Float
    user: User
    createdAt: String
    updatedAt: String
    projects: [Project!]!
  }

  type Settings {
    playback: PlaybackSettings
    editor: EditorSettings
    export: ExportSettings
    interface: InterfaceSettings
    shortcuts: ShortcutsSettings
    import: ImportSettings
    advanced: AdvancedSettings
  }

  type PlaybackSettings {
    volume: Float
    muted: Boolean
    autoRewindOnPause: AutoRewindSettings
    speedBounds: SpeedBoundsSettings
    showWaveform: Boolean
    waveformSnap: Boolean
    loopCurrentLine: Boolean
    speedPresets: [Float!]
    seekTime: Float
    seekPlays: Boolean
  }

  type AutoRewindSettings {
    enabled: Boolean
    seconds: Float
  }

  type SpeedBoundsSettings {
    min: Float
    max: Float
  }

  type EditorSettings {
    autoPauseOnMark: Boolean
    nudge: NudgeSettings
    autoAdvance: AutoAdvanceSettings
    showShiftAll: Boolean
    shiftAllAmount: Float
    showLineNumbers: Boolean
    timestampPrecision: String
    srt: SrtSettings
    history: HistorySettings
    display: DisplaySettings
    scroll: ScrollSettings
  }

  type NudgeSettings {
    fine: Float
    coarse: Float
    default: Float
  }

  type AutoAdvanceSettings {
    enabled: Boolean
    skipBlank: Boolean
    mode: String
  }

  type SrtSettings {
    defaultSubtitleDuration: Float
    minSubtitleGap: Float
    snapToNextLine: Boolean
  }

  type HistorySettings {
    limit: Int
    groupingThresholdMs: Float
  }

  type DisplaySettings {
    activeHighlight: String
    showNextLine: Boolean
    dualLine: Boolean
    languageLayout: String
    translationLayout: String
    readingFormat: String
    karaokeFillTrack: String
    karaokeFillEasing: String
  }

  type ScrollSettings {
    mode: String
    alignment: String
  }

  type ExportSettings {
    lineEndings: String
    copyFormat: String
    downloadFormat: String
    timestampPrecision: String
    defaultFilenamePattern: String
    includeMetadata: Boolean
    stripEmptyLines: Boolean
    normalizeTimestamps: Boolean
  }

  type InterfaceSettings {
    theme: String
    defaultLanguage: String
    fontSize: String
    spacing: String
    previewAlignment: String
    focusMode: String
    layoutSwap: Boolean
    playerTop: Boolean
    editorWidth: Float
    lockLayout: Boolean
    mobileTab: String
  }

  type ShortcutsSettings {
    mark: [String!]
    nudgeLeft: [String!]
    nudgeRight: [String!]
    nudgeLeftFine: [String!]
    nudgeRightFine: [String!]
    addLine: [String!]
    deleteLine: [String!]
    clearTimestamp: [String!]
    switchMode: [String!]
    deselect: [String!]
    showHelp: [String!]
    rangeSelect: [String!]
    toggleSelect: [String!]
    playPause: [String!]
    seekForward: [String!]
    seekBackward: [String!]
    mute: [String!]
    speedUp: [String!]
    speedDown: [String!]
    addSecondary: [String!]
    addTranslation: [String!]
    toggleTranslation: [String!]
    focusSync: [String!]
    focusPreview: [String!]
    focusPlayback: [String!]
  }

  type ImportSettings {
    expandRepeats: Boolean
  }

  type AdvancedSettings {
    autoSave: AutoSaveSettings
    confirmDestructive: Boolean
    timezone: String
  }

  type AutoSaveSettings {
    enabled: Boolean
    timeInterval: Float
  }

  type HealthStatus {
    status: String!
    version: String
    uptime: Float
  }

  type Query {
    health: HealthStatus!
    me: User
    project(id: ID!): Project
    projects(limit: Int, offset: Int): [Project!]!
    upload(id: ID!): Upload
    uploads(limit: Int, offset: Int): [Upload!]!
    settings: Settings
    getShare(id: ID!): Project
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

  input UpdateLyricsInput {
    editorMode: String
    language: String
    lines: [LineInput!]
  }

  input UpdateProfileInput {
    username: String
    bio: String
    avatarUrl: String
  }

  input UpdateSettingsInput {
    playback: PlaybackSettingsInput
    editor: EditorSettingsInput
    export: ExportSettingsInput
    interface: InterfaceSettingsInput
    shortcuts: ShortcutsSettingsInput
    import: ImportSettingsInput
    advanced: AdvancedSettingsInput
  }

  input AutoRewindSettingsInput {
    enabled: Boolean
    seconds: Float
  }

  input SpeedBoundsSettingsInput {
    min: Float
    max: Float
  }

  input PlaybackSettingsInput {
    volume: Float
    muted: Boolean
    autoRewindOnPause: AutoRewindSettingsInput
    speedBounds: SpeedBoundsSettingsInput
    showWaveform: Boolean
    waveformSnap: Boolean
    loopCurrentLine: Boolean
    speedPresets: [Float!]
    seekTime: Float
    seekPlays: Boolean
  }

  input NudgeSettingsInput {
    fine: Float
    coarse: Float
    default: Float
  }

  input AutoAdvanceSettingsInput {
    enabled: Boolean
    skipBlank: Boolean
    mode: String
  }

  input SrtSettingsInput {
    defaultSubtitleDuration: Float
    minSubtitleGap: Float
    snapToNextLine: Boolean
  }

  input HistorySettingsInput {
    limit: Int
    groupingThresholdMs: Float
  }

  input DisplaySettingsInput {
    activeHighlight: String
    showNextLine: Boolean
    dualLine: Boolean
    languageLayout: String
    translationLayout: String
    readingFormat: String
    karaokeFillTrack: String
    karaokeFillEasing: String
  }

  input ScrollSettingsInput {
    mode: String
    alignment: String
  }

  input EditorSettingsInput {
    autoPauseOnMark: Boolean
    nudge: NudgeSettingsInput
    autoAdvance: AutoAdvanceSettingsInput
    showShiftAll: Boolean
    shiftAllAmount: Float
    showLineNumbers: Boolean
    timestampPrecision: String
    srt: SrtSettingsInput
    history: HistorySettingsInput
    display: DisplaySettingsInput
    scroll: ScrollSettingsInput
  }

  input ExportSettingsInput {
    lineEndings: String
    copyFormat: String
    downloadFormat: String
    timestampPrecision: String
    wordTimestampPrecision: String
    defaultFilenamePattern: String
    includeMetadata: Boolean
    stripEmptyLines: Boolean
    normalizeTimestamps: Boolean
  }

  input InterfaceSettingsInput {
    theme: String
    defaultLanguage: String
    fontSize: String
    spacing: String
    previewAlignment: String
    focusMode: String
    layoutSwap: Boolean
    playerTop: Boolean
    editorWidth: Float
    lockLayout: Boolean
    mobileTab: String
  }

  input ShortcutsSettingsInput {
    mark: [String!]
    nudgeLeft: [String!]
    nudgeRight: [String!]
    nudgeLeftFine: [String!]
    nudgeRightFine: [String!]
    addLine: [String!]
    deleteLine: [String!]
    clearTimestamp: [String!]
    switchMode: [String!]
    deselect: [String!]
    showHelp: [String!]
    rangeSelect: [String!]
    toggleSelect: [String!]
    playPause: [String!]
    seekForward: [String!]
    seekBackward: [String!]
    mute: [String!]
    speedUp: [String!]
    speedDown: [String!]
    addSecondary: [String!]
    addTranslation: [String!]
    toggleTranslation: [String!]
    focusSync: [String!]
    focusPreview: [String!]
    focusPlayback: [String!]
  }

  input ImportSettingsInput {
    expandRepeats: Boolean
  }

  input AutoSaveSettingsInput {
    enabled: Boolean
    timeInterval: Float
  }

  input AdvancedSettingsInput {
    autoSave: AutoSaveSettingsInput
    confirmDestructive: Boolean
    timezone: String
  }

  input SaveMediaInput {
    source: String!
    cloudinaryUrl: String
    publicId: String
    youtubeUrl: String
    spotifyTrackId: String
    artist: String
    fileName: String
    title: String
    duration: Float
  }

  type Mutation {
    createProject(input: CreateProjectInput!): Project!
    updateProject(id: ID!, input: UpdateProjectInput!): Project!
    deleteProject(id: ID!): Boolean!
    updateLyrics(projectId: String!, input: UpdateLyricsInput!): Lyrics!
    updateProfile(input: UpdateProfileInput!): User!
    updateSettings(input: UpdateSettingsInput!): Settings!
    resetSettings: Boolean!
    saveMedia(input: SaveMediaInput!): Upload!
    deleteMedia(id: ID!): Boolean!
    cloneProject(id: ID!): Project!
  }
`;
