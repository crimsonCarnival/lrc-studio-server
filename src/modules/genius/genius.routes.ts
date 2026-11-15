import type { FastifyInstance } from 'fastify';
import { search, extract, connections } from './genius.controller.js';
import { searchQuerySchema, extractQuerySchema, connectionsQuerySchema } from './genius.schema.js';

export default async function geniusRoutes(fastify: FastifyInstance): Promise<void> {
  const rateLimit = { max: 20, timeWindow: '1 minute' };
  fastify.get('/search', { schema: searchQuerySchema, preHandler: [fastify.optionalAuth], config: { rateLimit } }, search);
  fastify.get('/extract', { schema: extractQuerySchema, preHandler: [fastify.optionalAuth], config: { rateLimit } }, extract);
  fastify.get('/connections', { schema: connectionsQuerySchema, preHandler: [fastify.optionalAuth], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, connections);
}
