import type { FastifyInstance } from 'fastify';
import * as controller from './notifications.controller.js';

export default async function notificationsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/',          { preHandler: [fastify.requireAuth] }, controller.list);
  fastify.post('/read',     { preHandler: [fastify.requireAuth] }, controller.markRead);
  fastify.post('/read-all', { preHandler: [fastify.requireAuth] }, controller.markAllRead);
  fastify.delete('/:id',    { preHandler: [fastify.requireAuth] }, controller.dismiss);
}
