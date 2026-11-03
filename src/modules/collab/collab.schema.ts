export const joinSchema = {
  body: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: {
      // nanoid(24); some slack so a mangled link fails as collab_link_invalid, not 400.
      token: { type: 'string', minLength: 1, maxLength: 64 },
      // Trimmed and checked for 1-40 in the service; this only bounds the raw input.
      name: { type: 'string', maxLength: 200 },
    },
  },
} as const;
