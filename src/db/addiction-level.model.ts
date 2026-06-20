import mongoose, { type Document } from 'mongoose';

/**
 * Flexible requirements: admins pick which stats count for this level.
 * Any field left as 0 / undefined is simply not required.
 */
export interface ILevelRequirements {
  syncedLines?: number;
  karaokeLines?: number;
  musicSyncedMinutes?: number;
  publicProjects?: number;
  starsReceived?: number;
  wordsTimestamped?: number;
  totalProjects?: number;
}

import type { LocalizedString } from '../modules/badges/badge-definition.model.js';

export interface IAddictionLevel extends Document {
  /** Unique slug-style ID, e.g. "tone_deaf" */
  id: string;
  /** Display title shown to the user */
  title: LocalizedString;
  /** Flavour description (shown in admin panel) */
  description: LocalizedString;
  /**
   * Minimum requirements to reach this level.
   * ALL non-zero fields must be satisfied simultaneously.
   */
  requirements: ILevelRequirements;
  /** Visual sort order in admin panel */
  order: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const requirementsSchema = new mongoose.Schema<ILevelRequirements>(
  {
    syncedLines:       { type: Number, default: 0, min: 0 },
    karaokeLines:      { type: Number, default: 0, min: 0 },
    musicSyncedMinutes:{ type: Number, default: 0, min: 0 },
    publicProjects:    { type: Number, default: 0, min: 0 },
    starsReceived:     { type: Number, default: 0, min: 0 },
    wordsTimestamped:  { type: Number, default: 0, min: 0 },
    totalProjects:     { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const addictionLevelSchema = new mongoose.Schema<IAddictionLevel>(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9_-]+$/,
    },
    title: {
      en: { type: String, required: true, trim: true, maxlength: 60 },
      es: { type: String, default: '', trim: true, maxlength: 60 }
    },
    description: {
      en: { type: String, default: '', trim: true, maxlength: 200 },
      es: { type: String, default: '', trim: true, maxlength: 200 }
    },
    requirements: {
      type: requirementsSchema,
      default: () => ({}),
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true, collection: 'addiction_levels' }
);

// Index for efficient "find highest satisfied level" queries
addictionLevelSchema.index({ order: -1 });

export default mongoose.model<IAddictionLevel>('AddictionLevel', addictionLevelSchema);
