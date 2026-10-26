import type { FastifyInstance } from 'fastify';
import { getEnv } from '../../config/env.js';

/**
 * The API host has no page of its own, so a browser that lands on its root is sent to the
 * app. Only the root: any other unknown path keeps its JSON 404, so a mistyped endpoint is
 * not mistaken for the website. The destination is the configured APP_URL, never request input.
 */
export default async function rootRoutes(fastify: FastifyInstance): Promise<void> {
  // 302, not 301: browsers cache a permanent redirect and would keep it after APP_URL changes.
  fastify.get('/', async (_req, reply) => reply.redirect(getEnv().APP_URL, 302));
}
