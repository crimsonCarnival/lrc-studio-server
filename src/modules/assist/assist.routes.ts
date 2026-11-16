import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nameCheck, titleSplit, describe, romanize, singers, usage } from './assist.controller.js';
import { nameCheckSchema, titleSplitSchema, describeSchema, romanizeSchema, singersSchema } from './assist.schema.js';

// Keyed on the authenticated user; `hook: 'preHandler'` makes the limiter run after requireAuth.
const limit = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 hour',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => `assist:${req.userId}`,
  },
});

export default async function assistRoutes(fastify: FastifyInstance): Promise<void> {
  // Fresh array per route: @fastify/rate-limit pushes its limiter onto the route's preHandler
  // array, so a shared array would stack every route's limiter on all of them.
  const preHandler = () => [fastify.requireAuth];
  fastify.post('/name-check', { preHandler: preHandler(), schema: nameCheckSchema, config: limit(60) }, nameCheck);
  fastify.post('/title-split', { preHandler: preHandler(), schema: titleSplitSchema, config: limit(60) }, titleSplit);
  fastify.post('/describe', { preHandler: preHandler(), schema: describeSchema, config: limit(30) }, describe);
  fastify.post('/romanize', { preHandler: preHandler(), schema: romanizeSchema, config: limit(30) }, romanize);
  fastify.post('/singers', { preHandler: preHandler(), schema: singersSchema, config: limit(30) }, singers);
  fastify.get('/usage', { preHandler: preHandler() }, usage);
}
