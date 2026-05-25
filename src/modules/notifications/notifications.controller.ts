import type { FastifyRequest, FastifyReply } from 'fastify';
import * as service from './notifications.service.js';

export async function list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await service.listNotifications(req.userId!);
  return reply.send(result);
}

export async function markRead(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { ids } = req.body as { ids: string[] };
  await service.markRead(req.userId!, ids);
  return reply.send({ ok: true });
}

export async function markAllRead(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await service.markAllRead(req.userId!);
  return reply.send({ ok: true });
}

export async function dismiss(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = req.params as { id: string };
  await service.dismiss(req.userId!, id);
  return reply.send({ ok: true });
}
