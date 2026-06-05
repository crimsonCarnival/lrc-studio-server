import type { FastifyRequest, FastifyReply } from 'fastify';
import * as projectService from './projects.service.js';
import { logUserAction } from '../user_logs/logs.service.js';
import { getIO } from '../../socket/socket.manager.js';

export function emitProjectUpdated(projectId: string, patch: Record<string, unknown>): void {
  try {
    getIO().to(`project:${projectId}`).emit('project:updated', { projectId, ...patch });
  } catch {
    // socket not initialized — safe to ignore
  }
}

/**
 * POST /projects — create a new project.
 */
export async function create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await projectService.createProject(req.body, req.userId, req.ip);
  if ('error' in result) {
    return reply.code((result as { status?: number }).status || 500).send(result);
  }
  return reply.code(201).send(result);
}

/**
 * GET /projects — list user's projects.
 */
export async function list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const projects = await projectService.listProjects(req.userId!);
  return reply.send({ projects });
}

/**
 * GET /projects/:id — get a single project.
 */
export async function get(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const project = await projectService.getProject((req.params as Record<string, string>).id, req.userId ?? null);
  if (!project) {
    return reply.code(404).send({ error: 'Project not found' });
  }
  return reply.send({ project });
}

/**
 * PUT /projects/:id — full project update.
 */
export async function update(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await projectService.updateProject(
    (req.params as Record<string, string>).id,
    req.body as Record<string, unknown>,
    req.userId
  );
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  emitProjectUpdated((req.params as Record<string, string>).id, req.body as Record<string, unknown>);
  // Ack to the saving client
  try {
    const socketId = req.headers['x-socket-id'] as string | undefined;
    if (socketId) {
      getIO().to(socketId).emit('autosave:ack', { projectId: (req.params as Record<string, string>).id, savedAt: Date.now() });
    }
  } catch { /* socket not ready */ }
  return reply.send(result);
}

/**
 * PATCH /projects/:id — partial project update.
 */
export async function patch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await projectService.patchProject(
    (req.params as Record<string, string>).id,
    req.body as Record<string, unknown>,
    req.userId
  );
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  emitProjectUpdated((req.params as Record<string, string>).id, req.body as Record<string, unknown>);
  // Ack to the saving client
  try {
    const socketId = req.headers['x-socket-id'] as string | undefined;
    if (socketId) {
      getIO().to(socketId).emit('autosave:ack', { projectId: (req.params as Record<string, string>).id, savedAt: Date.now() });
    }
  } catch { /* socket not ready */ }
  return reply.send(result);
}

/**
 * DELETE /projects/:id — delete a project.
 */
export async function remove(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await projectService.deleteProject((req.params as Record<string, string>).id, req.userId!);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.code(204).send();
}

/**
 * GET /projects/share/:id — get a project for public sharing (read-only).
 */
export async function getShare(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const projectId = (req.params as Record<string, string>).id;
  const project = await projectService.getShareProject(projectId);
  if (!project) {
    return reply.code(404).send({ error: 'Project not found' });
  }

  // Log the view — userId is null for anonymous visitors
  logUserAction({
    userId: req.userId || null,
    action: 'SHARED_PROJECT_VIEW',
    entityType: 'Project',
    entityId: projectId,
    ip: req.ip,
    deviceId: req.headers['x-device-id'] as string || 'unknown',
    metadata: { ownerId: (project as unknown as Record<string, unknown>).userId },
  });

  return reply.send({ project });
}

/**
 * POST /projects/clone/:id — clone a project (requires authentication).
 */
export async function clone(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sourceProjectId = (req.params as Record<string, string>).id;
  const result = await projectService.cloneProject(sourceProjectId, req.userId!);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }

  logUserAction({
    userId: req.userId!,
    action: 'PROJECT_CLONE',
    entityType: 'Project',
    entityId: sourceProjectId,
    ip: req.ip,
    deviceId: req.headers['x-device-id'] as string || 'unknown',
    metadata: { newProjectId: (result as Record<string, unknown>).projectId },
  });

  return reply.code(201).send(result);
}

