/**
 * Shared JSON Schema fragments — reused across multiple modules.
 * Import these from your module's own schema file, do not import
 * from here directly in route definitions.
 */

export const lineItemSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 2000 },
    timestamp: { type: ['number', 'null'] },
    endTime: { type: ['number', 'null'] },
    secondary: { type: ['string', 'null'], maxLength: 2000 },
    singers: {
      type: ['array', 'null'],
      items: { type: 'string', maxLength: 100 },
      maxItems: 4
    },
    translation: { type: ['string', 'null'], maxLength: 2000 },
    id: { type: 'string', maxLength: 50 },
    words: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          word: { type: 'string', maxLength: 500 },
          time: { type: ['number', 'null'] },
          reading: { type: 'string', maxLength: 500 },
        },
      },
    },
    secondaryWords: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          word: { type: 'string', maxLength: 500 },
          time: { type: ['number', 'null'] },
        },
      },
    },
  },
};

export const linesArray = { type: 'array', items: lineItemSchema, maxItems: 5000 };

export const projectIdParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1, maxLength: 21 } },
  required: ['id'],
};