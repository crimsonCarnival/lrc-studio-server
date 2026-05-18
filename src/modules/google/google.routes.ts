import type { FastifyInstance } from 'fastify';
import * as googleController from './google.controller.js';

export async function googleRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /google/auth/url — get authorization URL for account linking
  fastify.get('/auth/url', { preHandler: [fastify.requireAuth] }, googleController.authorize);

  // GET /google/login/url — get authorization URL for sign-in
  fastify.get('/login/url', googleController.authorizeLogin);

  // GET /google/auth/callback — OAuth callback (public)
  fastify.get('/auth/callback', googleController.callback);

  // POST /google/disconnect — disconnect Google account
  fastify.post('/disconnect', { preHandler: [fastify.requireAuth] }, googleController.disconnect);
}
