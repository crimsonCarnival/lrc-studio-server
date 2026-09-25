/**
 * Projects module — request validation schemas.
 */
import { linesArray, lineItemSchema, publicIdParam } from '../../shared/schemas.js';

export { publicIdParam };

// Mirrors MAX_SECTION_INDEX / MAX_LINE_INDEX / MAX_WORD_INDEX in
// projects.crud.service.ts — keep in sync; these bound the positional
// $set paths built from sectionIdx/lineIdx/wordIndex, so the schema must
// reject anything the service would otherwise throw a 400/422 on.
const MAX_SECTION_INDEX = 2000;
const MAX_LINE_INDEX = 10000;
const MAX_WORD_INDEX = 2000;

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

// Full sections replace — mirrors SectionInput in graphql/schema/lyrics.schema.ts
// and SectionEntry in types/index.ts.
const sectionItemSchema = {
  type: 'object',
  properties: {
    label: { type: ['string', 'null'], maxLength: 500 },
    depth: { type: ['number', 'null'] },
    id: { type: ['string', 'null'], maxLength: 50 },
    singers: {
      type: ['array', 'null'],
      items: { type: 'string', maxLength: 100 },
      maxItems: 4,
    },
    timestamp: { type: ['number', 'null'] },
    lines: linesArray,
  },
  additionalProperties: false,
};

// maxItems mirrors MAX_SECTION_INDEX (sectionIdx must address an existing/next slot).
const sectionsArray = { type: 'array', items: sectionItemSchema, maxItems: MAX_SECTION_INDEX };

// Positional word patch payload — mirrors WORD_FIELDS in projects.crud.service.ts.
const wordItemSchema = {
  type: 'object',
  properties: {
    id: { type: ['string', 'null'], maxLength: 50 },
    word: { type: 'string', maxLength: 500 },
    time: { type: ['number', 'null'] },
    reading: { type: 'string', maxLength: 500 },
    singerIndex: { type: ['number', 'null'], minimum: 0 },
  },
  additionalProperties: false,
};

export const lyricsSchema = {
  type: 'object',
  properties: {
    editorMode: { type: 'string', enum: ['lrc', 'srt', 'words'] },
    language: { type: ['string', 'null'], maxLength: 10 },
    // Legacy flat-line create payload.
    lines: linesArray,
    // Full sections replace (PATCH { lyrics: { sections } }).
    sections: sectionsArray,
    lineIndex: { type: 'integer', minimum: 0 },
    // Positional single-line patch: sections.<sectionIdx>.lines.<lineIdx>.<field>
    // — see patchLyricsWithSession in projects.crud.service.ts. Previously
    // missing here, so Fastify's AJV (additionalProperties: false, with
    // removeAdditional) silently stripped these before the service ever saw
    // them, turning every REST surgical-patch save into a no-op.
    sectionIdx: { type: 'integer', minimum: 0, maximum: MAX_SECTION_INDEX },
    lineIdx: { type: 'integer', minimum: 0, maximum: MAX_LINE_INDEX },
    line: lineItemSchema,
    // Positional word patch: sections.<sectionIdx>.lines.<lineIdx>.words.<wordIndex>.<field>
    wordIndex: { type: 'integer', minimum: 0, maximum: MAX_WORD_INDEX },
    word: wordItemSchema,
  },
  additionalProperties: false,
};

const PRIMARY_GENRES = ['pop','rock','hip_hop','rnb','electronic','jazz','classical','country','folk','metal','blues','soul','reggae','latin','alternative','soundtrack','world','other',''];

const metadataSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', maxLength: 2000 },
    genre: { type: 'string', enum: PRIMARY_GENRES },
    tags: {
      type: 'array',
      items: { type: 'string', minLength: 2, maxLength: 50 },
      maxItems: 10,
    },
    songName: { type: 'string', maxLength: 500 },
    songArtist: { type: 'string', maxLength: 500 },
    songAlbum: { type: 'string', maxLength: 500 },
    songYear: { type: 'string', maxLength: 4 },
    songLanguage: { type: 'string', maxLength: 10 },
    trackNumber: { type: ['integer', 'null'], minimum: 1, maximum: 999 },
    trackCount: { type: ['integer', 'null'], minimum: 1, maximum: 999 },
    // Limits mirror MAX_PROJECT_SINGERS / MAX_SINGER_NAME_LENGTH in project.model.ts.
    singers: {
      type: 'array',
      items: { type: 'string', maxLength: 60 },
      maxItems: 20,
    },
    // Listed explicitly: Fastify's default AJV strips unknown props (removeAdditional),
    // which silently dropped custom singer colors on every REST save.
    singerColors: {
      type: 'array',
      items: { type: 'string', maxLength: 9, pattern: '^(#[0-9a-fA-F]{3,8})?$' },
      maxItems: 20,
    },
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
    uploadUrl: { type: 'string', maxLength: 2048 },
    uploadPublicId: { type: 'string', maxLength: 500 },
    fileName: { type: 'string', maxLength: 500 },
    duration: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

export const createProjectSchema = { body: projectBodySchema };

export const updateProjectSchema = {
  body: projectBodySchema,
  params: publicIdParam,
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
      // Explicit user save vs autosave; omitted = autosave. Intent only — the
      // service decides from persisted state whether anything changed.
      saveKind: { type: 'string', enum: ['manual', 'auto'] },
    },
    additionalProperties: false,
  },
  params: publicIdParam,
};


