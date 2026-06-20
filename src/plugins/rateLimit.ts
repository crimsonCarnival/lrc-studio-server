import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import fastifyRateLimit from '@fastify/rate-limit';
import { getEnv } from '../config/env.js';

async function rateLimitPlugin(fastify: FastifyInstance): Promise<void> {
  const { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } = getEnv();
  await fastify.register(fastifyRateLimit, {
    global: true,
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req: FastifyRequest) => {
      const deviceId = req.headers['x-device-id'];
      if (typeof deviceId === 'string' && deviceId) {
        return `${req.ip}-${deviceId}`;
      }
      return req.ip;
    }
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });