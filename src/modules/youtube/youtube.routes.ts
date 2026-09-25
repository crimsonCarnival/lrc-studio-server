import type { FastifyInstance } from 'fastify';
import { searchYoutube, checkEmbed, checkAvailability } from './youtube.controller.js';
import { availabilityQuerySchema } from './youtube.schema.js';

export default async function youtubeRoutes(fastify: FastifyInstance): Promise<void> {
  const rateLimit = { max: 30, timeWindow: '1 minute' };
  fastify.get('/search', { preHandler: [fastify.optionalAuth], config: { rateLimit } }, searchYoutube);
  // attachValidation: the handler answers 400 with the stable `invalid_id` code instead of the generic validation_error.
  const availabilityOpts = { preHandler: [fastify.optionalAuth], config: { rateLimit }, schema: { querystring: availabilityQuerySchema }, attachValidation: true };
  fastify.get('/availability', availabilityOpts, checkAvailability);
  // Deprecated alias (legacy `{ embeddable }` shape) backed by the same service call.
  fastify.get('/check-embed', availabilityOpts, checkEmbed);
}
