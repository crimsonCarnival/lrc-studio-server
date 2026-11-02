import { linesArray } from '../../shared/schemas.js';

export const parseSchema = {
  body: {
    type: 'object',
    properties: {
      // 1 MiB: generous for a real LRC/SRT file (incl. word-level timestamps
      // and translations) while bounding the unauthenticated parse route's
      // worst-case input. Was 5 MiB with no auth at all on this route.
      content: { type: 'string', maxLength: 1048576 },
      filename: { type: 'string', maxLength: 255 },
      options: {
        type: 'object',
        properties: { preserveEmptyLines: { type: 'boolean' } },
      },
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
      // `metadata.artists` ([{ name, role }]) takes precedence over a plain `metadata.ar`.
      metadata: { type: 'object', additionalProperties: true },
      // Appends "(feat. …)" to [ti:] when the song has featured artists. Off by default.
      includeFeaturedInTitle: { type: 'boolean' },
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
      publicId: { type: 'string', maxLength: 40 },
    },
    required: ['lines'],
  },
};
