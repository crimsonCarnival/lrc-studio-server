import type { FastifyRequest, FastifyReply } from 'fastify';
import * as uploadService from './uploads.service.js';

export async function audioSignature(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // req.userId is null for guests (optionalAuth); service handles the null case.
  const result = await uploadService.generateAudioSignature(req.body as Record<string, unknown>, req.userId ?? null, req.ip);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}

export async function avatarSignature(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await uploadService.generateAvatarSignature(req.body as Record<string, unknown> || {}, req.userId!, req.ip);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}

export async function listMedia(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { limit, offset } = req.query as { limit?: string; offset?: string };
  const result = await uploadService.listMedia(req.userId!, { limit, offset });
  return reply.send(result);
}

export async function createMedia(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const upload = await uploadService.createMedia(req.userId!, req.body as Record<string, unknown>);
  return reply.code(201).send({ upload });
}

export async function deleteMedia(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await uploadService.deleteMedia((req.params as Record<string, string>).id, req.userId!, req.log as unknown as Record<string, unknown>);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.code(204).send();
}

export async function updateMedia(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await uploadService.updateMedia((req.params as Record<string, string>).id, req.userId!, req.body as Record<string, unknown>);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send({ upload: result });
}

export async function getMedia(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await uploadService.getMedia((req.params as Record<string, string>).id, req.userId!);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({ error: (result as Record<string, unknown>).error });
  }
  return reply.send(result);
}