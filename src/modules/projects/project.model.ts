import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import { stripHtml } from '../../utils/sanitize.js';

const textSetter = (v: unknown) => (typeof v === 'string' ? stripHtml(v) : v);

// --- Subdocument: Editor State ---
const stateSchema = new mongoose.Schema(
  {
    syncMode: { type: Boolean, default: false },
    activeLineIndex: { type: Number, default: 0 },
    playbackPosition: { type: Number, default: 0 },
    playbackSpeed: { type: Number, default: 1 },
    saveTime: { type: String, default: null, maxlength: 64 },
    timezone: { type: String, default: null, maxlength: 100 },
    utcOffset: { type: String, default: null, maxlength: 6 },
  },
  { _id: false }
);

// --- Subdocument: Metadata ---
const metadataSchema = new mongoose.Schema(
  {
    description: { type: String, default: '', maxlength: 2000, set: textSetter },
    tags: {
      type: [String],
      default: [],
      validate: {
      validator: (v: unknown[]) => v.length <= 20,
        message: 'Maximum 20 tags allowed',
      },
      set: (v: unknown) => (Array.isArray(v) ? v.map((t: unknown) => (typeof t === 'string' ? stripHtml(t).slice(0, 50) : t)) : v),
    },
    songName: { type: String, default: '', maxlength: 500, set: textSetter },
    songArtist: { type: String, default: '', maxlength: 500, set: textSetter },
    songAlbum: { type: String, default: '', maxlength: 500, set: textSetter },
    songYear: { type: String, default: '', maxlength: 4, set: textSetter },
    songGenre: { type: String, default: '', maxlength: 100, set: textSetter },
    songLanguage: { type: String, default: '', maxlength: 100, set: textSetter },
    trackNumber: { type: Number, default: null, min: 1, max: 999 },
    trackCount: { type: Number, default: null, min: 1, max: 999 },
    albumArt: { type: String, default: '', maxlength: 2000, set: textSetter },
  },
  { _id: false }
);

// --- Main: Project ---
const projectSchema = new mongoose.Schema(
  {
    projectId: {
      type: String,
      required: true,
      unique: true,
      default: () => nanoid(10),
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
      sparse: true,
    },
    title: { type: String, default: '', maxlength: 500, set: textSetter },

    // Audio reference to Upload collection (required)
    uploadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Upload',
      default: null,
      index: true,
    },

    // Lyrics stored in separate Lyrics collection, linked by lyricsId
    lyricsId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lyrics',
      default: null,
    },

    state: { type: stateSchema, default: () => ({}) },
    metadata: { type: metadataSchema, default: () => ({}) },
    coverImage: { type: String, default: '', maxlength: 2000, set: textSetter },
    readOnly: { type: Boolean, default: true },
    public: { type: Boolean, default: true },
    forksEnabled: { type: Boolean, default: true },
    trendingScore: { type: Number, default: 0 },

    forkedFrom: {
      projectId: { type: String, default: null },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      accountName: { type: String, default: null },
    },

    forkCount: { type: Number, default: 0 },
    starCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'projects' }
);

// Supports list query: by owner, sorted by recent updates
projectSchema.index({ userId: 1, updatedAt: -1 });
// Supports public project discovery and trending sorts
projectSchema.index({ public: 1, starCount: -1 });
projectSchema.index({ public: 1, createdAt: -1 });
projectSchema.index({ public: 1, trendingScore: -1 });
projectSchema.index({ forksEnabled: 1 });

// Methods
export interface IProjectMethods {
  isOwnedBy(userId: string | mongoose.Types.ObjectId): boolean;
  toPublic(): Record<string, unknown>;
}

projectSchema.methods.isOwnedBy = function (this: mongoose.Document & { userId?: mongoose.Types.ObjectId | null }, userId: string | mongoose.Types.ObjectId) {
  if (!this.userId || !userId) return false;
  return this.userId.toString() === userId.toString();
};

projectSchema.methods.toPublic = function (this: mongoose.Document) {
  const obj = this.toObject();
  obj.id = obj._id?.toString() || this.id;
  delete obj.__v;
  delete obj._id;
  return obj;
};

export default mongoose.model('Project', projectSchema);
