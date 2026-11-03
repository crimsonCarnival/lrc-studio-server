import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieOptions } from '../auth/auth.controller.js';
import { GUEST_COOKIE } from './collab.auth.js';
import { CollabError, joinSession } from './collab.service.js';

/** Same lifetime as the guest JWT it carries (collab.auth.ts GUEST_TTL). */
const GUEST_COOKIE_MAX_AGE = 12 * 60 * 60;

export type JoinBody = { token: string; name?: string };

export async function join(request: FastifyRequest<{ Body: JoinBody }>, reply: FastifyReply) {
  try {
    const res = await joinSession({
      token: request.body.token,
      name: request.body.name,
      userId: request.userId ?? null,
      guestCookie: request.cookies[GUEST_COOKIE],
      ip: request.ip,
      deviceId: request.headers['x-device-id'] as string | undefined,
    });
    if (res.guestToken) reply.setCookie(GUEST_COOKIE, res.guestToken, { ...cookieOptions, maxAge: GUEST_COOKIE_MAX_AGE });
    return reply.send({ ok: true, publicId: res.publicId, role: res.role });
  } catch (err) {
    if (err instanceof CollabError) return reply.code(err.status).send({ error: err.code, code: err.code });
    throw err;
  }
}
