import type { FastifyInstance, FastifyRequest } from 'fastify';
import { geniusAlbumCover, geniusAlbums, geniusArtists, geniusPhoto, projectCoverCopy, projectCovers } from './catalog.controller.js';
import { geniusAlbumCoverSchema, geniusAlbumsSchema, geniusArtistsSchema, geniusPhotoSchema, projectCoverCopySchema, projectCoversSchema } from './catalog.schema.js';

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
  fastify.get('/genius/albums', { preHandler: [fastify.requirePermission('catalog.manage')], schema: geniusAlbumsSchema, config: limit('catalog-genius-album-search') }, geniusAlbums);
  fastify.post('/genius/album-cover', { preHandler: [fastify.requirePermission('catalog.manage')], schema: geniusAlbumCoverSchema, config: limit('catalog-genius-album-cover') }, geniusAlbumCover);
  fastify.get('/album-covers/projects', { preHandler: [fastify.requirePermission('catalog.manage')], schema: projectCoversSchema, config: limit('catalog-project-covers') }, projectCovers);
  fastify.post('/album-covers/project', { preHandler: [fastify.requirePermission('catalog.manage')], schema: projectCoverCopySchema, config: limit('catalog-project-cover-copy') }, projectCoverCopy);
}
