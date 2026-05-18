export const settingsSchema = `
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
    wordTimestampPrecision: String
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
    toastPosition: String
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
    toastPosition: String
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
`;
