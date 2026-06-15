import type { FastifyInstance } from 'fastify';
import * as spotifyController from './spotify.controller.js';

const resolveSchema = {
  body: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['url'],
  },
};

const uploadSchema = {
  body: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['url'],
  },
};

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

export default async function spotifyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/lookup',
    {
      schema: lookupSchema,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    spotifyController.lookup
  );

  fastify.post(
    '/resolve',
    {
      schema: resolveSchema,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    spotifyController.resolve
  );

  fastify.post(
    '/upload',
    {
      schema: uploadSchema,
      preHandler: [fastify.requireActiveUser],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    spotifyController.createUpload
  );
}
