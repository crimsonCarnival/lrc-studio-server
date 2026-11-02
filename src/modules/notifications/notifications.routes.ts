import type { FastifyInstance } from 'fastify';
import * as controller from './notifications.controller.js';
import { markReadSchema, dismissSchema } from './notifications.schema.js';

export default async function notificationsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/',          { preHandler: [fastify.requireAuth] }, controller.list);
  fastify.post('/read',     { schema: markReadSchema, preHandler: [fastify.requireAuth] }, controller.markRead);
  fastify.post('/read-all', { preHandler: [fastify.requireAuth] }, controller.markAllRead);
  fastify.delete('/:id',    { schema: dismissSchema, preHandler: [fastify.requireAuth] }, controller.dismiss);
}
