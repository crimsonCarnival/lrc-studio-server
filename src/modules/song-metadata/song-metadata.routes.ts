import type { FastifyInstance } from 'fastify';
import * as songMetadataController from './song-metadata.controller.js';

const querystring = {
  type: 'object',
  properties: {
    songName:   { type: 'string', minLength: 1, maxLength: 200 },
    artistName: { type: 'string', maxLength: 200 },
    // Repeat the key for several (`featured=A&featured=B`); one value is coerced to a list.
    featured:   { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
  },
  required: ['songName'],
};

export default async function songMetadataRoutes(fastify: FastifyInstance): Promise<void> {
  const config = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  // Ranked candidates, best first, for the user to choose from.
  fastify.get('/search', { schema: { querystring }, config }, songMetadataController.search);
  // The single best match by the requested artist (404 when none). Older clients use it.
  fastify.get('/lookup', { schema: { querystring }, config }, songMetadataController.lookup);
}
