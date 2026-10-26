import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { JwtPayload, SignOptions } from 'jsonwebtoken';
import { getEnv } from '../config/env.js';
import { hasPermission, rankOf, ROLE_RANK, type Permission } from '../shared/permissions.js';

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
    _cachedDeviceBan?: { deviceId: string } | null;
    _cachedIpBan?: { ip: string } | null;
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

/**
 * True if `token` is a valid, unexpired admin sudo grant bound to `userId`.
 * Single source of truth for the requireSudo decorator and the GraphQL context.
 */
export function verifyAdminSudo(token: string | undefined, userId: string | undefined | null): boolean {
  if (!token || !userId) return false;
  try {
    const decoded = jwt.verify(token, getSudoSecret()) as JwtPayload;
    return decoded.scope === 'admin-sudo' && !!decoded.sub && decoded.sub === userId;
  } catch {
    return false;
  }
}

/** Parse JWT duration strings ("30m", "1d", "2h") to seconds. */
export function parseExpiry(str: string | undefined, fallbackSeconds: number): number {
  if (!str) return fallbackSeconds;
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  return fallbackSeconds;
}

const ACCESS_LIFETIME_SECONDS = parseExpiry(ACCESS_EXPIRY, 15 * 60);

// Access and refresh tokens share a secret, issuer and audience, so without a
// type claim a refresh token was accepted anywhere an access token was —
// outliving logout, session revocation and breach detection for its full TTL.
type TokenKind = 'access' | 'refresh';

function signAccess(payload: Record<string, unknown>): string {
  const opts: SignOptions = {
    expiresIn: ACCESS_EXPIRY as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
  };
  return jwt.sign({ ...payload, typ: 'access' }, JWT_SECRET, opts);
}

function signRefresh(payload: Record<string, unknown>): string {
  const opts: SignOptions = {
    expiresIn: REFRESH_EXPIRY as SignOptions['expiresIn'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
  };
  return jwt.sign({ ...payload, typ: 'refresh' }, JWT_SECRET, opts);
}

function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockTolerance: 30,
  }) as JwtPayload;
}

/**
 * Tokens minted before the `typ` claim carry none; classify those by lifetime.
 * This fallback only matters until the last pre-`typ` refresh token expires
 * (one JWT_REFRESH_EXPIRY after deploy) and can be removed after that.
 */
function tokenKind(decoded: JwtPayload): TokenKind {
  if (decoded.typ === 'access' || decoded.typ === 'refresh') return decoded.typ;
  const lifetime = (decoded.exp ?? 0) - (decoded.iat ?? 0);
  return lifetime > ACCESS_LIFETIME_SECONDS ? 'refresh' : 'access';
}

function verifyTokenOfKind(token: string, kind: TokenKind): JwtPayload {
  const decoded = verifyToken(token);
  if (tokenKind(decoded) !== kind) throw new jwt.JsonWebTokenError(`expected ${kind} token`);
  return decoded;
}

const verifyAccessToken = (token: string) => verifyTokenOfKind(token, 'access');
const verifyRefreshToken = (token: string) => verifyTokenOfKind(token, 'refresh');

/** Module-level jwt tools — use these when this.jwt is unavailable (e.g. in standalone exported handlers). */
export const jwtTools = { signAccess, signRefresh, verifyToken, verifyAccessToken, verifyRefreshToken };

/**
 * An access token is only as good as the session it was issued for. Without
 * this, logout / logout-all / password change / breach detection revoked the
 * refresh path but left every issued access token valid until expiry.
 */
async function isSessionLive(decoded: JwtPayload): Promise<boolean> {
  if (!decoded.sub || typeof decoded.familyId !== 'string') return false;
  const Session = (await import('../db/session.model.js')).default;
  return !!(await Session.exists({ familyId: decoded.familyId, userId: decoded.sub, isValid: true }));
}

/** Verified access token whose session is still valid; throws like jwt.verify otherwise. */
export async function verifyLiveAccessToken(token: string): Promise<JwtPayload> {
  const decoded = verifyAccessToken(token);
  if (!(await isSessionLive(decoded))) throw new jwt.JsonWebTokenError('session revoked');
  return decoded;
}

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
  // `!== undefined`, not truthiness: a legitimately cached `null` (deleted
  // or nonexistent user) is falsy, so a truthiness check here re-queried on
  // every preHandler in the chain for exactly the requests that most need
  // to fail fast.
  if (request._cachedAuthUser !== undefined) return request._cachedAuthUser;
  const user = await lookupUser(userId);
  request._cachedAuthUser = user;
  return user;
}

// Same caching as getOrFetchUser, for the device/IP ban lookups. Multiple
// preHandlers in one chain (requireStaff then requirePermission on the same
// /admin route, for example) each used to re-run both of these — this makes
// the second call free, same as the user lookup already was.
async function getOrCheckDeviceBan(request: FastifyRequest, deviceId: string | undefined): Promise<{ deviceId: string } | null> {
  if (request._cachedDeviceBan !== undefined) return request._cachedDeviceBan;
  const result = deviceId ? await checkDeviceBan(deviceId) : null;
  request._cachedDeviceBan = result;
  return result;
}

async function getOrCheckIpBan(request: FastifyRequest, ip: string | undefined): Promise<{ ip: string } | null> {
  if (request._cachedIpBan !== undefined) return request._cachedIpBan;
  const result = ip ? await checkIpBan(ip) : null;
  request._cachedIpBan = result;
  return result;
}

/**
 * The 403 message when this request's device or IP is banned, else null.
 * Superadmins are exempt, as they already are at login: otherwise anyone
 * holding network.block could lock the superadmin out by banning their IP.
 */
async function networkBanMessage(request: FastifyRequest, user: CachedAuthUser): Promise<string | null> {
  if (user.role === 'superadmin') return null;
  const [deviceBanned, ipBanned] = await Promise.all([
    getOrCheckDeviceBan(request, request.headers['x-device-id'] as string | undefined),
    getOrCheckIpBan(request, request.ip),
  ]);
  if (deviceBanned) return 'Access restricted from this device due to previous violations.';
  if (ipBanned) return 'Access restricted from this network.';
  return null;
}

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorate('jwt', jwtTools);

  // The Fastify decorator initialiser; userId starts as undefined and is set during auth
  fastify.decorateRequest('userId', undefined);

  fastify.decorate('optionalAuth', async function (request: FastifyRequest) {
    const token = request.cookies.accessToken;
    if (!token) return;
    try {
      const decoded = await verifyLiveAccessToken(token);
      const user = await getOrFetchUser(request, decoded.sub);
      if (!user || user.deletedAt) return;
      await user.checkBanStatus();
      if (user.ban?.active) {
        (request as FastifyRequest & { bannedUserId?: string }).bannedUserId = decoded.sub;
        return;
      }
      // optionalAuth builds the GraphQL context, so skipping this left a banned
      // device or network with full read/write access to the data graph.
      if (await networkBanMessage(request, user)) return;
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
      decoded = await verifyLiveAccessToken(token);
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

    const networkBan = await networkBanMessage(request, user);
    if (networkBan) {
      reply.code(403).send({ error: networkBan });
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
      decoded = await verifyLiveAccessToken(token);
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

    const networkBan = await networkBanMessage(request, user);
    if (networkBan) {
      reply.code(403).send({ error: networkBan });
      return;
    }

    const ip = request.ip;

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

  // Gate for the permissions-management surface (editing role presets and
  // individual staff permissions). Deliberately checks the literal `role`
  // string rather than any permission — granting/revoking permissions IS the
  // escalation surface this guards, so it cannot be gated by a permission
  // itself (that would let a superadmin-granted permission bootstrap more
  // permissions). rankOf() is a second, independent check as defense in depth.
  fastify.decorate('requireSuperadmin', async function (request: FastifyRequest, reply: FastifyReply) {
    const result = await resolveAndCheckBan(request, reply);
    if (!result) return;
    if (result.role !== 'superadmin' || rankOf(result.role) !== ROLE_RANK.superadmin) {
      reply.code(403).send({ error: 'superadmin_required' });
    }
  });

  fastify.decorate('signAdminSudo', signAdminSudo);

  // Gate for destructive admin actions. Must run AFTER requireAdmin (which sets
  // request.userId). Requires a valid, unexpired sudo grant bound to this user.
  fastify.decorate('requireSudo', async function (request: FastifyRequest, reply: FastifyReply) {
    if (!verifyAdminSudo(request.cookies.adminSudo, request.userId)) {
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
      decoded = await verifyLiveAccessToken(token);
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
      decoded = await verifyLiveAccessToken(token);
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