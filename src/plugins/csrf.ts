import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { getEnv } from '../config/env.js';
import { buildAppOriginAllowlist } from '../config/allowed-origins.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Auth cookies are SameSite=None in production, so a cross-site page can make
 * the browser send them. CORS does not stop that: it only hides the response,
 * and a form post (text/plain or multipart) needs no preflight. Browsers
 * describe where a state-changing request came from, so a cross-site one is
 * refused before any handler runs.
 *
 * Sec-Fetch-Site is checked first because it is computed by the browser
 * against the page's site, which makes www/admin/m and the /api proxy all
 * "same-site" without each subdomain having to be listed in CORS_ORIGIN (the
 * proxied hosts never needed a CORS entry). Origin against the configured
 * allowlist is the fallback for browsers that do not send it.
 *
 * Requests with neither header are not from a browser (curl, server-to-server)
 * and cannot carry a victim's cookies, so they pass.
 */
export function isCrossSiteWrite(
  method: string,
  headers: { origin?: string; 'sec-fetch-site'?: string | string[] },
  allowed: Set<string>,
): boolean {
  if (SAFE_METHODS.has(method)) return false;
  const site = headers['sec-fetch-site'];
  if (site) return site === 'cross-site';
  const origin = headers.origin;
  if (origin) return origin === 'null' || !allowed.has(origin);
  return false;
}

async function csrfPlugin(fastify: FastifyInstance): Promise<void> {
  const allowed = buildAppOriginAllowlist(getEnv());
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isCrossSiteWrite(request.method, request.headers as Parameters<typeof isCrossSiteWrite>[1], allowed)) {
      return reply.code(403).send({ error: 'cross_site_request_blocked' });
    }
  });
}

export default fp(csrfPlugin, { name: 'csrf' });
