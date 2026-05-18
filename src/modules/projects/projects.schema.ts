/**
 * Projects module — request validation schemas.
 */
import { linesArray, projectIdParam } from '../../shared/schemas.js';

export { projectIdParam };

export const stateSchema = {
  type: 'object',
  properties: {
    syncMode: { type: 'boolean' },
    activeLineIndex: { type: 'integer', minimum: 0 },
    playbackPosition: { type: 'number', minimum: 0 },
    playbackSpeed: { type: 'number', minimum: 0.05, maximum: 10 },
    saveTime: { type: 'string', maxLength: 64 },
    timezone: { type: 'string', maxLength: 100 },
    utcOffset: { type: 'string', pattern: '^[+-]\\d{2}:\\d{2}$' },
  },
  additionalProperties: false,
};

export const lyricsSchema = {
  type: 'object',
  properties: {
    editorMode: { type: 'string', enum: ['lrc', 'srt', 'words'] },
    language: { type: ['string', 'null'], maxLength: 10 },
    lines: linesArray,
    lineIndex: { type: 'integer', minimum: 0 },
    line: { type: 'object' },
    wordIndex: { type: 'integer', minimum: 0 },
    word: { type: 'object' },
  },
  additionalProperties: false,
};

const metadataSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', maxLength: 2000 },
    tags: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 20 },
    songName: { type: 'string', maxLength: 500 },
    songArtist: { type: 'string', maxLength: 500 },
    songAlbum: { type: 'string', maxLength: 500 },
    songYear: { type: 'string', maxLength: 4 },
  },
  additionalProperties: false,
};

const projectBodySchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 500 },
    uploadId: { type: 'string', pattern: '^[a-f0-9]{24}$' },
    lyrics: lyricsSchema,
    state: stateSchema,
    metadata: metadataSchema,
    readOnly: { type: 'boolean' },
    public: { type: 'boolean' },
    recaptchaToken: { type: 'string', minLength: 1, maxLength: 8192 },
    ytUrl: { type: 'string', maxLength: 2048 },
    cloudinaryUrl: { type: 'string', maxLength: 2048 },
    cloudinaryPublicId: { type: 'string', maxLength: 500 },
    fileName: { type: 'string', maxLength: 500 },
    duration: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

export const createProjectSchema = { body: projectBodySchema };

export const updateProjectSchema = {
  body: projectBodySchema,
  params: projectIdParam,
};

export const patchProjectSchema = {
  body: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 500 },
      uploadId: { type: 'string', pattern: '^[a-f0-9]{24}$' },
      lyrics: lyricsSchema,
      state: stateSchema,
      metadata: metadataSchema,
      readOnly: { type: 'boolean' },
      public: { type: 'boolean' },
      version: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  params: projectIdParam,
};


