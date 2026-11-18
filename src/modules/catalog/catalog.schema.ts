export const geniusArtistsSchema = {
  querystring: {
    type: 'object',
    required: ['q'],
    properties: { q: { type: 'string', minLength: 1, maxLength: 200 } },
  },
};

// geniusId only: the image URL always comes from Genius via the service, never from the client.
// Fastify's default AJV strips unknown keys under additionalProperties:false; propertyNames.enum rejects them.
export const geniusPhotoSchema = {
  body: {
    type: 'object',
    required: ['geniusId'],
    additionalProperties: false,
    propertyNames: { enum: ['geniusId'] },
    properties: { geniusId: { type: 'integer', minimum: 1 } },
  },
};
