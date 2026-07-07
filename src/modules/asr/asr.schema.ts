export const stampJsonSchema = {
  body: {
    type: 'object',
    required: ['lines'],
    additionalProperties: false,
    // Exactly one audio source: a body with both (or neither) fails validation.
    oneOf: [{ required: ['uploadId'] }, { required: ['youtubeUrl'] }],
    properties: {
      uploadId: { type: 'string', minLength: 1, maxLength: 64 },
      youtubeUrl: { type: 'string', minLength: 11, maxLength: 200 },
      fuzzyTolerance: { type: 'number', minimum: 0.5, maximum: 1 },
      lines: {
        type: 'array', minItems: 1, maxItems: 2000,
        items: {
          type: 'object', required: ['index', 'text'], additionalProperties: false,
          properties: {
            index: { type: 'integer', minimum: 0 },
            text: { type: 'string', maxLength: 1000 },
            wordTokens: {
              type: 'array', maxItems: 500,
              items: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    },
  },
} as const;
