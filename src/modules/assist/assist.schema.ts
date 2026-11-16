// Fastify's default AJV runs with removeAdditional, which silently strips unknown keys under
// `additionalProperties: false`. `propertyNames.enum` rejects them with a 400 instead.
const line = { type: 'string', maxLength: 500 } as const;
const heavyLines = { type: 'array', minItems: 1, maxItems: 200, items: line } as const;

export const nameCheckSchema = {
  body: {
    type: 'object',
    required: ['title'],
    propertyNames: { enum: ['title', 'artist', 'album'] },
    anyOf: [{ required: ['artist'] }, { required: ['album'] }],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      artist: { type: 'string', minLength: 1, maxLength: 300 },
      album: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
} as const;

export const titleSplitSchema = {
  body: {
    type: 'object',
    required: ['title'],
    propertyNames: { enum: ['title'] },
    properties: { title: { type: 'string', minLength: 1, maxLength: 500 } },
  },
} as const;

export const describeSchema = {
  body: {
    type: 'object',
    required: ['lines'],
    propertyNames: { enum: ['title', 'artist', 'lines'] },
    properties: {
      title: { type: 'string', maxLength: 500 },
      artist: { type: 'string', maxLength: 300 },
      lines: { type: 'array', minItems: 1, maxItems: 40, items: line },
    },
  },
} as const;

export const romanizeSchema = {
  body: {
    type: 'object',
    required: ['lines'],
    propertyNames: { enum: ['lines', 'language'] },
    properties: {
      lines: heavyLines,
      language: { type: 'string', maxLength: 35 },
    },
  },
} as const;

export const singersSchema = {
  body: {
    type: 'object',
    required: ['lines', 'roster'],
    propertyNames: { enum: ['lines', 'roster'] },
    properties: {
      lines: heavyLines,
      roster: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 100 } },
    },
  },
} as const;
