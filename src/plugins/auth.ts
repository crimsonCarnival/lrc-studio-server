import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import type { JwtPayload, SignOptions } from 'jsonwebtoken';
import { getEnv } from '../config/env.js';

const env = getEnv();
const JWT_SECRET = env.JWT_SECRET;

if (env.NODE_ENV === 'production' && (!JWT_SECRET || JWT_SECRET === 'change-me')) {
  throw new Error('FATAL: JWT_SECRET must be set to a strong value in production.');
}

const ACCESS_EXPIRY = env.JWT_ACCESS_EXPIRY;
const REFRESH_EXPIRY = env.JWT_REFRESH_EXPIRY;
const JWT_ISSUER = env.JWT_ISSUER;
const JWT_AUDIENCE = env.JWT_AUDIENCE;

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

async function lookupUser(userId: string | undefined): Promise<any> {
  if (!userId) return null;
  const User = (await import('../db/user.model.js')).default;
  return User.findById(userId);
}

async function checkDeviceBan(deviceId: string): Promise<any> {
  if (!deviceId) return null;
  const BannedDevice = (await import('../modules/admin/bannedDevice.model.js')).default;
  return BannedDevice.findOne({ deviceId });
}

async function checkIpBan(ip: string): Promise<any> {
  if (!ip) return null;
  const BannedIp = (await import('../modules/admin/bannedIp.model.js')).default;
  return BannedIp.findOne({ ip });
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorate('jwt', { signAccess, signRefresh, verifyToken });

  fastify.decorateRequest('userId', null);

  fastify.decorate('optionalAuth', async function (request: FastifyRequest) {
    const token = request.cookies.accessToken;
    if (!token) return;
    try {
      const decoded = verifyToken(token) as JwtPayload;
      const user = await lookupUser(decoded.sub);
      if (!user || user.deletedAt || user.isBanned) return;
      await user.checkBanStatus();
      if (user.isBanned) return;
      request.userId = decoded.sub;
    } catch (err: any) {
      // Expired token: treat as anonymous but flag it so resolvers can surface
      // a 401 instead of silently failing ownership checks (which produce a 403).
      if (err?.name === 'TokenExpiredError') {
        (request as any).tokenExpired = true;
      }
      // Any other error (malformed token etc.) — silently treat as anonymous
    }
  });

  async function resolveAndCheckBan(request: FastifyRequest, reply: FastifyReply): Promise<any> {
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

    const user = await lookupUser(decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
    return null;
    }
    await user.checkBanStatus();
    if (user.isBanned) {
      reply.code(403).send({ error: 'User is banned' });
    return null;
    }

    const deviceId = request.headers['x-device-id'];
    if (deviceId) {
      const deviceBanned = await checkDeviceBan(deviceId as string);
      if (deviceBanned) {
        reply.code(403).send({ error: 'Access restricted from this device due to previous violations.' });
      return null;
      }
    }

    const ip = request.ip;
    if (ip) {
      const ipBanned = await checkIpBan(ip);
      if (ipBanned) {
        reply.code(403).send({ error: 'Access restricted from this network.' });
      return null;
      }
    }

    request.userId = decoded.sub;
    return user;
  }

  fastify.decorate('requireAuth', async function (request: FastifyRequest, reply: FastifyReply) {
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

    const user = await lookupUser(decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
    return null;
    }

    await user.checkBanStatus();
    if (user.isBanned) {
      reply.code(403).send({ error: 'User is banned' });
    return null;
    }

    const deviceId = request.headers['x-device-id'];
    if (deviceId) {
      const deviceBanned = await checkDeviceBan(deviceId as string);
      if (deviceBanned) {
        reply.code(403).send({ error: 'Access restricted from this device due to previous violations.' });
      return null;
      }
    }

    const ip = request.ip;
    if (ip) {
      const ipBanned = await checkIpBan(ip);
      if (ipBanned) {
        reply.code(403).send({ error: 'Access restricted from this network.' });
      return null;
      }
    }

    request.userId = decoded.sub;
  });

  fastify.decorate('requireActiveUser', async function (request: FastifyRequest, reply: FastifyReply) {
    const result = await resolveAndCheckBan(request, reply);
    if (!result) return;
  });

  fastify.decorate('requireAdmin', async function (request: FastifyRequest, reply: FastifyReply) {
    const result = await resolveAndCheckBan(request, reply);
    if (!result) return;
    if (result.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin access required' });
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

    const user = await lookupUser(decoded.sub);
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

    const user = await lookupUser(decoded.sub);
    if (!user || user.deletedAt) {
      reply.code(401).send({ error: 'User not found' });
      return;
    }

    request.userId = decoded.sub;
  });
}

export default fp(authPlugin, { name: 'auth' });