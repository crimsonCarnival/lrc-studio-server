// Size bounds only: the controllers keep answering a missing query/track with their own
// error, and normalize everything else themselves. These strings are forwarded upstream.
export const searchQuerySchema = {
  querystring: {
    type: 'object',
    properties: { q: { type: 'string', maxLength: 300 } },
  },
};

export const extractQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      track: { type: 'string', maxLength: 300 },
      artist: { type: 'string', maxLength: 300 },
      album: { type: 'string', maxLength: 300 },
      duration: { type: 'string', maxLength: 16 },
      id: { type: 'string', maxLength: 100 },
      publicId: { type: 'string', maxLength: 40 },
    },
  },
};
