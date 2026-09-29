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
      // Every mutation is served from /graphql, so its bucket must not be
      // something the caller chooses. X-Device-Id is a client-supplied header:
      // keying on it lets one client mint an unlimited number of buckets just
      // by rotating it. Auth routes are already IP-only for exactly this
      // reason, and the anonymous view-count dedup trusts the same header, so
      // rotating it otherwise defeats the counter and its only backstop at once.
      if (req.url.startsWith('/graphql')) return req.ip;

      const deviceId = req.headers['x-device-id'];
      if (typeof deviceId === 'string' && deviceId) {
        return `${req.ip}-${deviceId}`;
      }
      return req.ip;
    }
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });