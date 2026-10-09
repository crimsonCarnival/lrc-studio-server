import type { FastifyInstance } from 'fastify';
import { getOgImage, getOgMeta, getProjectOgPage } from './og.controller.js';
import { ogImageParamsSchema, ogMetaQuerySchema, ogProjectPageSchema } from './og.schema.js';

/**
 * Crawler-facing Open Graph surface. Every route is unauthenticated and reads
 * from Mongo, so each one carries an explicit rate limit rather than inheriting
 * the global bucket — whose key still includes the caller-supplied
 * `X-Device-Id` (see plugins/rateLimit.ts) and is therefore rotatable.
 *
 * ASSUMPTION on the limits: a crawler fetches one card per shared link and the
 * Vercel middleware sits in front with its own cache, so 120/min covers a burst
 * of link unfurls with room to spare while still bounding an unauthenticated
 * DB-read loop. Raise `max` if the middleware is ever deployed without caching.
 */
const META_RATE_LIMIT = { max: 120, timeWindow: '1 minute' };
const IMAGE_RATE_LIMIT = { max: 240, timeWindow: '1 minute' };

export default async function ogRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/meta',
    { schema: ogMetaQuerySchema, config: { rateLimit: META_RATE_LIMIT } },
    getOgMeta,
  );

  fastify.get(
    '/image/:type/:id',
    { schema: ogImageParamsSchema, config: { rateLimit: IMAGE_RATE_LIMIT } },
    getOgImage,
  );

  fastify.get(
    '/project/:publicId',
    { schema: ogProjectPageSchema, config: { rateLimit: META_RATE_LIMIT } },
    getProjectOgPage,
  );
}
