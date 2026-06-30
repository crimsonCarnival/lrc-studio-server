import type { FastifyInstance } from 'fastify';
import { searchYoutube, checkEmbed } from './youtube.controller.js';

export default async function youtubeRoutes(fastify: FastifyInstance): Promise<void> {
  const rateLimit = { max: 30, timeWindow: '1 minute' };
  fastify.get('/search', { preHandler: [fastify.optionalAuth], config: { rateLimit } }, searchYoutube);
  fastify.get('/check-embed', { preHandler: [fastify.optionalAuth], config: { rateLimit } }, checkEmbed);
}