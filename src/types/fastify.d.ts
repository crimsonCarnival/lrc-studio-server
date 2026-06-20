import 'fastify';
import type { JwtPayload } from 'jsonwebtoken';

declare module 'fastify' {
  interface FastifyInstance {
    jwt: {
      signAccess(payload: Record<string, unknown>): string;
      signRefresh(payload: Record<string, unknown>): string;
      verifyToken(token: string): JwtPayload;
    };
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireActiveUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuthForAppeal: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAuthLax: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    // Admin "sudo mode": destructive admin actions require a fresh password
    // re-auth (short-lived grant), so a hijacked admin session alone is not
    // enough to ban/delete/change roles. See F24.
    requireSudo: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    signAdminSudo: (userId: string) => string;
  }

  interface FastifyRequest {
    userId?: string | null;
  }
}