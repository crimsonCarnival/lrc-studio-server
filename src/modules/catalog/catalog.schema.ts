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

export const geniusAlbumsSchema = geniusArtistsSchema;
export const geniusAlbumCoverSchema = geniusPhotoSchema;

export const projectCoversSchema = {
  querystring: {
    type: 'object',
    required: ['artistId', 'title'],
    properties: {
      artistId: { type: 'string', minLength: 24, maxLength: 24 },
      title: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
};

// The cover itself is looked up server-side from publicId; the client never sends a URL.
export const projectCoverCopySchema = {
  body: {
    type: 'object',
    required: ['artistId', 'title', 'publicId'],
    additionalProperties: false,
    propertyNames: { enum: ['artistId', 'title', 'publicId'] },
    properties: {
      artistId: { type: 'string', minLength: 24, maxLength: 24 },
      title: { type: 'string', minLength: 1, maxLength: 500 },
      publicId: { type: 'string', minLength: 1, maxLength: 40 },
    },
  },
};