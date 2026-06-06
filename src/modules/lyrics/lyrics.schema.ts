import { linesArray } from '../../shared/schemas.js';

export const parseSchema = {
  body: {
    type: 'object',
    properties: {
      content: { type: 'string', maxLength: 5242880 },
      filename: { type: 'string', maxLength: 255 },
    },
    required: ['content'],
  },
};

export const compileLrcSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      includeTranslations: { type: 'boolean' },
      precision: { type: 'string', enum: ['hundredths', 'thousandths'] },
      metadata: { type: 'object', additionalProperties: true },
      lineEndings: { type: 'string', enum: ['lf', 'crlf'] },
      includeSecondary: { type: 'boolean' },
      wordPrecision: { type: 'string' },
      exportTranslationIndex: { type: 'integer', minimum: 0 },
    },
    required: ['lines'],
  },
};

export const compileSrtSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      duration: { type: ['number', 'null'] },
      includeTranslations: { type: 'boolean' },
      lineEndings: { type: 'string', enum: ['lf', 'crlf'] },
      srtConfig: { type: 'object' },
      includeSecondary: { type: 'boolean' },
    },
    required: ['lines'],
  },
};

export const inferEndTimesSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      duration: { type: ['number', 'null'] },
      srtConfig: { type: 'object' },
    },
    required: ['lines'],
  },
};

export const markSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      activeLineIndex: { type: 'integer', minimum: 0 },
      time: { type: 'number', minimum: 0 },
      editorMode: { type: 'string', enum: ['lrc', 'srt', 'words'] },
      activeWordIndex: { type: 'integer', minimum: 0 },
      stampTarget: { type: 'string', enum: ['main', 'secondary'] },
      awaitingEndMark: { type: ['integer', 'null'] },
      focusedTimestamp: {
        type: ['object', 'null'],
        properties: {
          lineIndex: { type: 'integer', minimum: 0 },
          type: { type: 'string', enum: ['start', 'end', 'word'] },
          wordIndex: { type: 'integer', minimum: 0 },
        },
      },
      settings: {
        type: 'object',
        properties: {
          autoAdvance: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              skipBlank: { type: 'boolean' },
            },
          },
          srt: {
            type: 'object',
            properties: {
              snapToNextLine: { type: 'boolean' },
              minSubtitleGap: { type: 'number' },
            },
          },
        },
      },
    },
    required: ['lines', 'activeLineIndex', 'time', 'editorMode', 'settings'],
  },
};

export const bulkShiftSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      selectedIndices: { type: 'array', items: { type: 'integer', minimum: 0 } },
      delta: { type: 'number' },
    },
    required: ['lines', 'selectedIndices', 'delta'],
  },
};

export const globalOffsetSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      delta: { type: 'number' },
    },
    required: ['lines', 'delta'],
  },
};

export const clearAllSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      isSrt: { type: 'boolean' },
      isWords: { type: 'boolean' },
    },
    required: ['lines'],
  },
};

export const clearLineSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      index: { type: 'integer', minimum: 0 },
      isSrt: { type: 'boolean' },
      isWords: { type: 'boolean' },
    },
    required: ['lines', 'index'],
  },
};

export const detectDuplicatesSchema = {
  body: {
    type: 'object',
    properties: {
      lines: linesArray,
      threshold: { type: 'number', minimum: 0 },
    },
    required: ['lines'],
  },
};