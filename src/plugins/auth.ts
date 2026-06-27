import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { JwtPayload, SignOptions } from 'jsonwebtoken';
import { getEnv } from '../config/env.js';
import { hasPermission, type Permission } from '../shared/permissions.js';

interface CachedAuthUser {
  deletedAt?: Date | null;
  ban?: { active?: boolean };
  checkBanStatus(): Promise<void>;
  role?: string;
  permissions?: string[];
  lastIp?: string;
  accountName?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    _cachedAuthUser?: CachedAuthUser | null; // cached to avoid duplicate DB lookups within one request
  }
}

const env = getEnv();
const JWT_SECRET = env.JWT_SECRET;

if (env.NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET === 'change-me')) {
  throw new Error('FATAL: JWT_SECRET must be set to a strong value in production.');
}

const ACCESS_EXPIRY = env.JWT_ACCESS_EXPIRY;
const REFRESH_EXPIRY = env.JWT_REFRESH_EXPIRY;
const JWT_ISSUER = env.JWT_ISSUER;
const JWT_AUDIENCE = env.JWT_AUDIENCE;

// Admin sudo grants are signed with a key domain-separated from the session
// secret, so a sudo token can never double as an access/refresh token. (F24)
const ADMIN_SUDO_TTL_SECONDS = 5 * 60;
function getSudoSecret(): string {
  if (process.env.ADMIN_SUDO_SECRET) return process.env.ADMIN_SUDO_SECRET;
  return crypto.createHmac('sha256', JWT_SECRET).update('admin-sudo-v1').digest('hex');
}
function signAdminSudo(userId: string): string {
  return jwt.sign({ scope: 'admin-sudo' }, getSudoSecret(), { subject: userId, expiresIn: ADMIN_SUDO_TTL_SECONDS });
}

function signAccess(payload: Record<string, unknown>): string {
  const opts: SignOptions = {
    expiresIn: ACCESS_EXPIRY as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
  };
  return jwt.sign(payload, JWT_SECRET, opts);
}

function signRefresh(payload: Record<string, unknown>): string {
  const opts: SignOptions = {
    expiresIn: REFRESH_EXPIRY as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
  };
  return jwt.sign(payload, JWT_SECRET, opts);
}

function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockTolerance: 30,
  }) as JwtPayload;
}

/** Module-level jwt tools — use these when this.jwt is unavailable (e.g. in standalone exported handlers). */
export const jwtTools = { signAccess, signRefresh, verifyToken };

// Only the fields needed for auth checks — avoids loading passwordHash, etc.
const AUTH_USER_SELECT = 'ban appeal isDeleted deletedAt role permissions accountName lastIp';

async function lookupUser(userId: string | undefined): Promise<CachedAuthUser | null> {
  if (!userId) return null;
  const User = (await import('../db/user.model.js')).default;
  return User.findById(userId).select(AUTH_USER_SELECT) as unknown as CachedAuthUser | null;
}

async function checkDeviceBan(deviceId: string): Promise<{ deviceId: string } | null> {
  if (!deviceId) return null;
  const BannedDevice = (await import('../modules/admin/bannedDevice.model.js')).default;
  return BannedDevice.findOne({ deviceId }) as unknown as Promise<{ deviceId: string } | null>;
}

async function checkIpBan(ip: string): Promise<{ ip: string } | null> {
  if (!ip) return null;
  const BannedIp = (await import('../modules/admin/bannedIp.model.js')).default;
  return BannedIp.findOne({ ip }) as unknown as Promise<{ ip: string } | null>;
}

async function getOrFetchUser(request: FastifyRequest, userId: string | undefined) {
  if (request._cachedAuthUser) return request._cachedAuthUser;
  const user = await lookupUser(userId);
  request._cachedAuthUser = user;
  return user;
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorate('jwt', { signAccess, signRefresh, verifyToken });

  // The Fastify decorator initialiser; userId starts as undefined and is set during auth
  fastify.decorateRequest('userId', undefined);

  fastify.decorate('optionalAuth', async function (request: FastifyRequest) {
    const token = request.cookies.accessToken;
    if (!token) return;
    try {
      const decoded = verifyToken(token) as JwtPayload;
      const user = await getOrFetchUser(request, decoded.sub);
      if (!user || user.deletedAt) return;
      await user.checkBanStatus();
      if (user.ban?.active) {
        (request as FastifyRequest & { bannedUserId?: string }).bannedUserId = decoded.sub;
        return;
      }
      request.userId = decoded.sub;
    } catch (err: unknown) {
      // Expired token: treat as anonymous but flag it so resolvers can surface
      // a 401 instead of silently failing ownership checks (which produce a 403).
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        (request as FastifyRequest & { tokenExpired?: boolean }).tokenExpired = true;
      }
      // Any other error (malformed token etc.) — silently treat as anonymous
    }
  });

  async function resolveAndCheckBan(request: FastifyRequest, reply: FastifyReply): Promise<CachedAuthUser | null> {
    const token = request.cookies.accessToken;
    if (!token) {
      reply.code(401).send({ error: 'Authentication required' });
    return null;
    }
    let decoded: JwtPayload;
    try {
      decoded = verifyToken(token) as JwtPayload;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
    return null;
    }

    const user = await getOrFetchUser(request, decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
    return null;
    }
    await user.checkBanStatus();
    if (user.ban?.active) {
      reply.code(403).send({ error: 'User is banned' });
    return null;
    }

    const deviceId = request.headers['x-device-id'] as string | undefined;
    const ip = request.ip;

    const [deviceBanned, ipBanned] = await Promise.all([
      deviceId ? checkDeviceBan(deviceId) : Promise.resolve(null),
      ip ? checkIpBan(ip) : Promise.resolve(null),
    ]);

    if (deviceBanned) {
      reply.code(403).send({ error: 'Access restricted from this device due to previous violations.' });
      return null;
    }
    if (ipBanned) {
      reply.code(403).send({ error: 'Access restricted from this network.' });
      return null;
    }

    request.userId = decoded.sub;
    return user;
  }

  fastify.decorate('requireAuth', async function (request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.accessToken;
    if (!token) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    let decoded: JwtPayload;
    try {
      decoded = verifyToken(token) as JwtPayload;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }

    const user = await getOrFetchUser(request, decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
      return;
    }

    await user.checkBanStatus();
    if (user.ban?.active) {
      reply.code(403).send({ error: 'User is banned' });
      return;
    }

    const deviceId = request.headers['x-device-id'] as string | undefined;
    const ip = request.ip;

    const [deviceBanned, ipBanned] = await Promise.all([
      deviceId ? checkDeviceBan(deviceId) : Promise.resolve(null),
      ip ? checkIpBan(ip) : Promise.resolve(null),
    ]);

    if (deviceBanned) {
      reply.code(403).send({ error: 'Access restricted from this device due to previous violations.' });
      return;
    }
    if (ipBanned) {
      reply.code(403).send({ error: 'Access restricted from this network.' });
      return;
    }

    request.userId = decoded.sub;

    // Fire-and-forget IP update — no await, never blocks the request
    if (ip && user.lastIp !== ip) {
      import('../db/user.model.js').then(({ default: User }) => {
        User.updateOne({ _id: decoded.sub }, { $set: { lastIp: ip } }).catch(() => {});
      });
    }
  });

  fastify.decorate('requireActiveUser', async function (request: FastifyRequest, reply: FastifyReply) {
    const result = await resolveAndCheckBan(request, reply);
    if (!result) return;
  });

  // Blanket gate for the /admin surface: authenticated, not banned, and holding
  // at least one permission (i.e. any staff member). Per-route requirePermission
  // hooks then enforce the specific capability.
  fastify.decorate('requireStaff', async function (request: FastifyRequest, reply: FastifyReply) {
    const result = await resolveAndCheckBan(request, reply);
    if (!result) return;
    if (!result.permissions || result.permissions.length === 0) {
      return reply.code(403).send({ error: 'Staff access required' });
    }
  });

  // Factory: returns a preHandler that requires a specific permission. Runs
  // resolveAndCheckBan itself (sets request.userId), so it works standalone or
  // after requireStaff (the cached auth user makes the second call free).
  fastify.decorate('requirePermission', function (permission: Permission) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
      const result = await resolveAndCheckBan(request, reply);
      if (!result) return;
      if (!hasPermission(result.permissions, permission)) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }
    };
  });

  fastify.decorate('signAdminSudo', signAdminSudo);

  // Gate for destructive admin actions. Must run AFTER requireAdmin (which sets
  // request.userId). Requires a valid, unexpired sudo grant bound to this user.
  fastify.decorate('requireSudo', async function (request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.adminSudo;
    if (!token) {
      reply.code(403).send({ error: 'sudo_required' });
      return;
    }
    try {
      const decoded = jwt.verify(token, getSudoSecret()) as JwtPayload;
      if (decoded.scope !== 'admin-sudo' || !decoded.sub || decoded.sub !== request.userId) {
        reply.code(403).send({ error: 'sudo_required' });
        return;
      }
    } catch {
      reply.code(403).send({ error: 'sudo_required' });
    }
  });

  fastify.decorate('requireAuthForAppeal', async function (request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.accessToken;
    if (!token) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    let decoded: JwtPayload;
    try {
      decoded = verifyToken(token) as JwtPayload;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }

    const user = await getOrFetchUser(request, decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
      return;
    }

    request.userId = decoded.sub;
  });

  fastify.decorate('requireAuthLax', async function (request: FastifyRequest, reply: FastifyReply) {
    const token = request.cookies.accessToken;
    if (!token) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    let decoded: JwtPayload;
    try {
      decoded = verifyToken(token) as JwtPayload;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }

    const user = await getOrFetchUser(request, decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
      return;
    }

    request.userId = decoded.sub;
  });
}

export default fp(authPlugin, { name: 'auth' });