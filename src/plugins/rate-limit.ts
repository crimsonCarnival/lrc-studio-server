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
    // x-ratelimit-* publishes the exact remaining budget and window to every
    // caller, which is useful to nobody but someone tuning an abuse loop
    // against the client-rotatable buckets below. retry-after stays on the
    // 429 response — a well-behaved client backing off needs that one.
    addHeadersOnExceeding: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
    },
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
    keyGenerator: (req: FastifyRequest) => {
      // Every mutation is served from /graphql, so its bucket must not be
      // something the caller chooses. X-Device-Id is a client-supplied header:
      // keying on it lets one client mint an unlimited number of buckets just
      // by rotating it. Auth routes are already IP-only for exactly this
      // reason, and the anonymous view-count dedup trusts the same header, so
      // rotating it otherwise defeats the counter and its only backstop at once.
      if (req.url.startsWith('/graphql')) return req.ip;

      // Same reasoning as /graphql: the lyrics compute routes (parse, the
      // /compile/* and /editor/* mark/bulk-shift/etc. handlers — both
      // prefixes route to the same lyrics module) are CPU-bound and several
      // are unauthenticated, so a client-rotatable key would let one caller
      // mint an unlimited number of buckets against them.
      if (req.url.startsWith('/lyrics') || req.url.startsWith('/editor')) return req.ip;

      const deviceId = req.headers['x-device-id'];
      if (typeof deviceId === 'string' && deviceId) {
        return `${req.ip}-${deviceId}`;
      }
      return req.ip;
    }
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });