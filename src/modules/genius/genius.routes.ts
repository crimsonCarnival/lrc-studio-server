import type { FastifyInstance } from 'fastify';
import { search, extract } from './genius.controller.js';
import { searchQuerySchema, extractQuerySchema } from './genius.schema.js';

export default async function geniusRoutes(fastify: FastifyInstance): Promise<void> {
  const rateLimit = { max: 20, timeWindow: '1 minute' };
  fastify.get('/search', { schema: searchQuerySchema, preHandler: [fastify.optionalAuth], config: { rateLimit } }, search);
  fastify.get('/extract', { schema: extractQuerySchema, preHandler: [fastify.optionalAuth], config: { rateLimit } }, extract);
}
