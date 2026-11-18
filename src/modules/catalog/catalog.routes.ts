import type { FastifyInstance, FastifyRequest } from 'fastify';
import { geniusArtists, geniusPhoto } from './catalog.controller.js';
import { geniusArtistsSchema, geniusPhotoSchema } from './catalog.schema.js';

// requirePermission('catalog.manage') re-reads the user from the DB (and sets request.userId) in the route's
// own preHandler; the service re-checks via assertManager. `hook: 'preHandler'` makes the limiter run after
// it (the plugin appends its hook to the route's preHandler array), so the key generator sees userId.
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
  fastify.get('/genius/artists', { preHandler: [fastify.requirePermission('catalog.manage')], schema: geniusArtistsSchema, config: limit('catalog-genius-search') }, geniusArtists);
  fastify.post('/genius/photo', { preHandler: [fastify.requirePermission('catalog.manage')], schema: geniusPhotoSchema, config: limit('catalog-genius-photo') }, geniusPhoto);
}
