import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { join, type JoinBody } from './collab.controller.js';
import { joinSchema } from './collab.schema.js';

export default async function collabRoutes(fastify: FastifyInstance): Promise<void> {
  // IP only: X-Device-Id is client-supplied and would mint a bucket per request
  // (see auth.routes.ts). Bounds invite-token guessing and member churn.
  const rateLimit = { max: 20, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.ip };

  // A caller presenting a session goes through requireAuth's gates (live session,
  // account ban, device/IP ban) and is never downgraded to a guest. Guests get the
  // device/IP ban check in the service.
  async function signedInGate(request: FastifyRequest, reply: FastifyReply) {
    if (request.cookies.accessToken) await fastify.requireAuth(request, reply);
  }

  fastify.post<{ Body: JoinBody }>('/join', { preHandler: [signedInGate], schema: joinSchema, config: { rateLimit } }, join);
}
