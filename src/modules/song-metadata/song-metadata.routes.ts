import type { FastifyInstance } from 'fastify';
import * as songMetadataController from './song-metadata.controller.js';

const lookupSchema = {
  querystring: {
    type: 'object',
    properties: {
      songName:   { type: 'string', minLength: 1, maxLength: 200 },
      artistName: { type: 'string', maxLength: 200 },
    },
    required: ['songName'],
  },
};

export default async function songMetadataRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/lookup',
    {
      schema: lookupSchema,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    songMetadataController.lookup
  );
}
