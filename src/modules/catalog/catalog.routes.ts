import type { FastifyInstance, FastifyRequest } from 'fastify';
import { geniusArtists, geniusPhoto } from './catalog.controller.js';
import { geniusArtistsSchema, geniusPhotoSchema } from './catalog.schema.js';

// catalog.manage is re-checked from the DB in the service (assertManager); the route only
// authenticates. `hook: 'preHandler'` makes the limiter run after requireAuth so the key sees userId.
const limit = (name: string) => ({
  rateLimit: {
    max: 30,
    timeWindow: '1 hour',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => `${name}:${req.userId ?? req.ip}`,
  },
});

export default async function catalogRoutes(fastify: FastifyInstance): Promise<void> {
  // Fresh array per route: @fastify/rate-limit pushes its limiter onto the route's preHandler array.
  fastify.get('/genius/artists', { preHandler: [fastify.requireAuth], schema: geniusArtistsSchema, config: limit('catalog-genius-search') }, geniusArtists);
  fastify.post('/genius/photo', { preHandler: [fastify.requireAuth], schema: geniusPhotoSchema, config: limit('catalog-genius-photo') }, geniusPhoto);
}
