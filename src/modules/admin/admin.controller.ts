import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import * as adminService from './admin.service.js';
import * as authService from '../auth/auth.service.js';
import { getIO } from '../../socket/socket.manager.js';
import User from '../../db/user.model.js';

/** Issue the short-lived admin sudo grant cookie. (F24) */
function setSudoCookie(req: FastifyRequest, reply: FastifyReply): void {
  const token = req.server.signAdminSudo(req.userId!);
  reply.setCookie('adminSudo', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    // The server mounts this route at /admin, but the client always calls
    // through the /api proxy (vite dev proxy and the prod reverse proxy both
    // strip /api before forwarding), so the browser's actual request path is
    // /api/admin/... — a Path of "/admin" never prefix-matches that, so the
    // cookie was silently dropped on every retry. Match the other auth
    // cookies (accessToken/refreshToken) and use the root path.
    path: '/',
    maxAge: 5 * 60,
  });
}

/** Report which step-up factors this admin can use (password and/or passkey). */
export async function sudoFactors(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const factors = await authService.getSudoFactors(req.userId!);
  return reply.send(factors);
}

/**
 * Re-authenticate the admin with their password and issue a short-lived sudo
 * grant cookie. Destructive admin routes (ban/delete/role/xp/...) require this
 * grant, so a hijacked admin session alone can't perform them. (F24)
 */
export async function sudo(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { password } = (req.body as { password?: string }) ?? {};
  if (!password) return reply.code(400).send({ error: 'password_required' });

  const user = await User.findById(req.userId!);
  if (!user) return reply.code(404).send({ error: 'user_not_found' });
  if (user.passwordHash === 'OAUTH_NO_PASSWORD') {
    // OAuth-only admin has no password — they must step up with a passkey instead.
    return reply.code(400).send({ error: 'no_password' });
  }
  if (!(await user.verifyPassword(password))) {
    return reply.code(401).send({ error: 'invalid_password' });
  }

  setSudoCookie(req, reply);
  return reply.send({ success: true, expiresIn: 300 });
}

/** WebAuthn options for a passkey-based sudo step-up. */
export async function sudoPasskeyOptions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.getSudoPasskeyOptions(req.userId!);
  if (result.error) return reply.code(result.status || 500).send({ error: result.error });
  return reply.send(result);
}

/** Verify a passkey sudo step-up and issue the grant on success. */
export async function sudoPasskeyVerify(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.verifySudoPasskey(req.userId!, req.body as AuthenticationResponseJSON);
  if (result.error) return reply.code(result.status || 500).send({ error: result.error });
  setSudoCookie(req, reply);
  return reply.send({ success: true, expiresIn: 300 });
}

export async function getUsers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.listUsers(req.query as Record<string, unknown>);
  return reply.send(result);
}

export async function banUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { reason, bannedUntil, banIp, banDevice } = req.body as Record<string, unknown>;
  const result = await adminService.toggleBan(
    (req.params as Record<string, string>).id,
    true,
    reason as string,
    bannedUntil as string | null,
    banIp as boolean,
    banDevice as boolean,
    req.userId!,
    req.ip
  );
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  }
  try {
    getIO().to(`user:${(req.params as Record<string, string>).id}`).emit('user:banned', { reason });
  } catch { /* socket not ready */ }
  return reply.send(result);
}

export async function unbanUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.toggleBan((req.params as Record<string, string>).id, false, null, null, false, false, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function rejectAppeal(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.rejectAppeal((req.params as Record<string, string>).id, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function changeRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.changeUserRole((req.params as Record<string, string>).id, (req.body as Record<string, string>).role, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function deleteUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.deleteUser((req.params as Record<string, string>).id, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function reactivateUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.reactivateUser((req.params as Record<string, string>).id, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function getStats(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.getStats();
  return reply.send(result);
}

export async function getBannedIps(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.listBannedIps();
  return reply.send(result);
}

export async function blockIp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { ip, reason } = req.body as Record<string, string>;
  const result = await adminService.blockIp(ip, reason, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function unblockIp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.unblockIp((req.params as Record<string, string>).id, req.userId!, req.ip);
  return reply.send(result);
}

export async function getAuditLogs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.listAdminLogs(req.query as Record<string, unknown>);
  return reply.send(result);
}

export async function getBannedDevices(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.listBannedDevices();
  return reply.send(result);
}

export async function blockDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { deviceId, reason } = req.body as Record<string, string>;
  const result = await adminService.blockDevice(deviceId, reason, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function unblockDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.unblockDevice((req.params as Record<string, string>).id, req.userId!, req.ip);
  return reply.send(result);
}
export async function shadowBanUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = req.params as { id: string };
  const { feed = true, search = true, reason = null } = req.body as { feed?: boolean; search?: boolean; reason?: string | null };
  const result = await adminService.toggleShadowBan(id, feed, search, reason, req.userId!, req.ip);
  if (result.error) return reply.code(result.status as number).send({ error: result.error });
  reply.send(result);
}

export async function unshadowBanUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = req.params as { id: string };
  const result = await adminService.toggleShadowBan(id, false, false, null, req.userId!, req.ip);
  if (result.error) return reply.code(result.status as number).send({ error: result.error });
  reply.send(result);
}

export async function adjustXP(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { action, amount, target, userId, userIds } = req.body as Record<string, unknown>;
  if (!['grant', 'revoke'].includes(action as string)) return reply.code(400).send({ error: 'action must be grant or revoke' });
  if (!amount || typeof amount !== 'number' || amount <= 0) return reply.code(400).send({ error: 'amount must be a positive number' });
  if (amount > adminService.MAX_XP_GRANT) return reply.code(400).send({ error: `amount exceeds the per-grant limit of ${adminService.MAX_XP_GRANT}` });
  if (!['all', 'user', 'users'].includes(target as string)) return reply.code(400).send({ error: 'target must be all, user, or users' });
  const result = await adminService.adjustXP(
    action as 'grant' | 'revoke',
    amount as number,
    target as 'all' | 'user' | 'users',
    req.userId!,
    userId as string | undefined,
    userIds as string[] | undefined,
    req.ip
  );
  return reply.send(result);
}
