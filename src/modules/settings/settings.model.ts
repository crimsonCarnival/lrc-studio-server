import mongoose from 'mongoose';

const { Schema } = mongoose;
const sub = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

const autoRewindSchema = sub({
  enabled: { type: Boolean },
  seconds: { type: Number, min: 0 },
});

const speedBoundsSchema = sub({
  min: { type: Number, min: 0.1, max: 10 },
  max: { type: Number, min: 0.1, max: 10 },
});

const playbackSchema = sub({
  volume: { type: Number, min: 0, max: 1 },
  muted: Boolean,
  autoRewindOnPause: { type: autoRewindSchema },
  speedBounds: { type: speedBoundsSchema },
  showWaveform: Boolean,
  waveformSnap: Boolean,
  loopCurrentLine: Boolean,
  speedPresets: { type: [Number] },
  seekTime: { type: Number, min: 1 },
  seekPlays: Boolean,
});

const nudgeSchema = sub({
  fine: { type: Number, min: 0 },
  coarse: { type: Number, min: 0 },
  default: { type: Number, min: 0 },
});

const autoAdvanceSchema = sub({
  enabled: Boolean,
  skipBlank: Boolean,
  mode: { type: String, enum: ['next', 'next-unsynced', 'same'] },
});

const srtSchema = sub({
  defaultSubtitleDuration: { type: Number, min: 0 },
  minSubtitleGap: { type: Number, min: 0 },
  snapToNextLine: Boolean,
});

const historySchema = sub({
  limit: { type: Number, min: 1, max: 500 },
  groupingThresholdMs: { type: Number, min: 0 },
});

const displaySchema = sub({
  activeHighlight: { type: String, enum: ['glow', 'zoom', 'color', 'dim', 'underline', 'none'] },
  showNextLine: Boolean,
  dualLine: Boolean,
  languageLayout: { type: String, enum: ['stacked', 'side-by-side'] },
  translationLayout: { type: String, enum: ['stacked', 'side-by-side'] },
  readingFormat: { type: String, enum: ['hiragana', 'katakana', 'romaji'] },
  karaokeFillTrack: { type: String, enum: ['main', 'secondary', 'both'] },
  karaokeFillEasing: { type: String, enum: ['linear', 'ease-in-out'], default: 'linear' },
});

const scrollSchema = sub({
  mode: { type: String, enum: ['smooth', 'instant', 'none'] },
  alignment: { type: String, enum: ['center', 'start', 'nearest', 'none'] },
});

const editorSchema = sub({
  autoPauseOnMark: Boolean,
  nudge: { type: nudgeSchema },
  autoAdvance: { type: autoAdvanceSchema },
  showShiftAll: Boolean,
  shiftAllAmount: { type: Number, min: 0 },
  showLineNumbers: Boolean,
  timestampPrecision: { type: String, enum: ['hundredths', 'thousandths', 'milliseconds', 'seconds'] },
  srt: { type: srtSchema },
  history: { type: historySchema },
  display: { type: displaySchema },
  scroll: { type: scrollSchema },
});

const exportSchema = sub({
  lineEndings: { type: String, enum: ['lf', 'crlf'] },
  copyFormat: { type: String, enum: ['lrc', 'srt', 'txt'] },
  downloadFormat: { type: String, enum: ['lrc', 'srt', 'txt'] },
  timestampPrecision: { type: String, enum: ['hundredths', 'thousandths', 'milliseconds', 'seconds'] },
  defaultFilenamePattern: { type: String, enum: ['fixed', 'media', 'title', 'date'] },
  includeMetadata: Boolean,
  stripEmptyLines: Boolean,
  normalizeTimestamps: Boolean,
  wordTimestampPrecision: { type: String, enum: ['hundredths', 'thousandths', 'milliseconds', 'seconds'] },
});

const interfaceSchema = sub({
  theme: { type: String, enum: ['system', 'dark', 'light', 'dracula', 'alucard', 'alucardlight'] },
  defaultLanguage: { type: String, maxlength: 10, match: /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/ },
  fontSize: { type: String, enum: ['small', 'normal', 'large', 'xlarge'] },
  spacing: { type: String, enum: ['compact', 'normal', 'relaxed'] },
  previewAlignment: { type: String, enum: ['left', 'center', 'right'] },
  focusMode: { type: String, enum: ['default', 'sync', 'playback'] },
  layoutSwap: { type: Boolean, default: false },
  playerTop: { type: Boolean, default: false },
  editorWidth: { type: Number, min: 20, max: 90, default: 50 },
  lockLayout: { type: Boolean, default: false },
  mobileTab: { type: String, enum: ['editor', 'preview'], default: 'editor' },
  toastPosition: { type: String, enum: ['bottom-right', 'bottom-center', 'bottom-left'], default: 'bottom-right' },
});

const shortcutString = { type: String, maxlength: 50, match: /^[a-zA-Z0-9+\-_.?!@#$%^&*()=\[\]{}|;:',<>/~`]+$/ };

const shortcutsSchema = sub({
  mark: { type: [shortcutString] },
  nudgeLeft: { type: [shortcutString] },
  nudgeRight: { type: [shortcutString] },
  nudgeLeftFine: { type: [shortcutString] },
  nudgeRightFine: { type: [shortcutString] },
  addLine: { type: [shortcutString] },
  deleteLine: { type: [shortcutString] },
  clearTimestamp: { type: [shortcutString] },
  switchMode: { type: [shortcutString] },
  deselect: { type: [shortcutString] },
  showHelp: { type: [shortcutString] },
  rangeSelect: { type: [shortcutString] },
  toggleSelect: { type: [shortcutString] },
  playPause: { type: [shortcutString] },
  seekForward: { type: [shortcutString] },
  seekBackward: { type: [shortcutString] },
  mute: { type: [shortcutString] },
  speedUp: { type: [shortcutString] },
  speedDown: { type: [shortcutString] },
  addSecondary: { type: [shortcutString] },
  addTranslation: { type: [shortcutString] },
  toggleTranslation: { type: [shortcutString] },
  focusSync: { type: [shortcutString] },
  focusPreview: { type: [shortcutString] },
  focusPlayback: { type: [shortcutString] },
});

const importSchema = sub({
  expandRepeats: Boolean,
});

const autoSaveSchema = sub({
  enabled: Boolean,
  timeInterval: { type: Number, min: 5 },
});

const advancedSchema = sub({
  autoSave: { type: autoSaveSchema },
  confirmDestructive: Boolean,
  timezone: { type: String, maxlength: 50, match: /^(auto|[A-Za-z_]+\/[A-Za-z_\/]+)$/ },
});

const settingsSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    playback: { type: playbackSchema, default: () => ({}) },
    editor: { type: editorSchema, default: () => ({}) },
    export: { type: exportSchema, default: () => ({}) },
    interface: { type: interfaceSchema, default: () => ({}) },
    shortcuts: { type: shortcutsSchema, default: () => ({}) },
    import: { type: importSchema, default: () => ({}) },
    advanced: { type: advancedSchema, default: () => ({}) },
  },
  { timestamps: true, minimize: false, collection: 'settings' }
);

export interface ISettingsMethods {
  toPublic(): Record<string, unknown>;
}

settingsSchema.methods.toPublic = function (this: mongoose.Document) {
  const obj = this.toObject();
  delete obj._id;
  delete obj.__v;
  delete obj.userId;
  delete obj.createdAt;
  delete obj.updatedAt;
  return obj;
};

export default mongoose.model<mongoose.Document, mongoose.Model<mongoose.Document, any, ISettingsMethods>>('Settings', settingsSchema);