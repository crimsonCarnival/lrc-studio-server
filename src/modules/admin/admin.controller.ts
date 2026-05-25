import type { FastifyRequest, FastifyReply } from 'fastify';
import * as adminService from './admin.service.js';
import { getIO } from '../../socket/socket.manager.js';

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
    req.userId!
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
  const result = await adminService.toggleBan((req.params as Record<string, string>).id, false);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function rejectAppeal(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.rejectAppeal((req.params as Record<string, string>).id);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function changeRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.changeUserRole((req.params as Record<string, string>).id, (req.body as Record<string, string>).role);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function deleteUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.deleteUser((req.params as Record<string, string>).id);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function reactivateUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.reactivateUser((req.params as Record<string, string>).id);
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
  const result = await adminService.blockIp(ip, reason, req.userId!);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function unblockIp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.unblockIp((req.params as Record<string, string>).id);
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
  const result = await adminService.blockDevice(deviceId, reason, req.userId!);
  if ((result as Record<string, unknown>).error) return reply.code((result as Record<string, number>).status || 500).send({ error: (result as Record<string, unknown>).error });
  return reply.send(result);
}

export async function unblockDevice(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await adminService.unblockDevice((req.params as Record<string, string>).id);
  return reply.send(result);
}