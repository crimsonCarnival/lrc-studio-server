import mongoose from 'mongoose';
import { stripHtml } from '../../utils/sanitize.js';

const textSetter = (v: string) => (typeof v === 'string' ? stripHtml(v) : v);

// --- Subdocument: Word ---
const wordSchema = new mongoose.Schema(
  {
    word: { type: String, default: '', maxlength: 500, set: textSetter },
    time: { type: Number, default: null },
    reading: { type: String, default: '', maxlength: 500, set: textSetter },
  },
  { _id: false }
);

// --- Subdocument: Line ---
const lineSchema = new mongoose.Schema(
  {
    text: { type: String, default: '', maxlength: 2000, set: textSetter },
    timestamp: { type: Number, default: null },
    endTime: { type: Number, default: null },
    secondary: { type: String, default: null, maxlength: 2000, set: textSetter },
    translation: { type: String, default: null, maxlength: 2000, set: textSetter },
    words: { type: [wordSchema], default: undefined },
    secondaryWords: {
      type: [
        {
          word: { type: String, default: '', maxlength: 500, set: textSetter },
          time: { type: Number, default: null },
          _id: false,
        },
      ],
      default: undefined,
    },
  },
  { _id: false }
);

// --- Main: Lyrics ---
const lyricsSchema = new mongoose.Schema(
  {
    projectId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    editorMode: {
      type: String,
      enum: ['lrc', 'srt', 'words'],
      default: 'lrc',
    },
    language: {
      type: String,
      default: null,
      maxlength: 10,
    },
    lines: { type: [lineSchema], default: [] },

    // Optimistic locking
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'lyrics' }
);

// Additional indexes for query performance
lyricsSchema.index({ updatedAt: -1 }); // For sorting by last modified
lyricsSchema.index({ 'lines.timestamp': 1 }); // For timestamp queries

// Validate SRT endTime > timestamp when both are set
lyricsSchema.pre('validate', function (next) {
  if (this.lines) {
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line.timestamp != null && line.endTime != null && line.endTime <= line.timestamp) {
        return next(new Error(`Line ${i}: endTime (${line.endTime}) must be greater than timestamp (${line.timestamp})`));
      }
    }
  }
  next();
});

lyricsSchema.methods.toPublic = function () {
  const obj = this.toObject();
  obj.id = obj._id?.toString();
  delete obj.__v;
  delete obj._id;
  return obj;
};

export default mongoose.model('Lyrics', lyricsSchema);