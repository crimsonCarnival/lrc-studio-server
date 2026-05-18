import type { FastifyInstance } from 'fastify';
import * as projectController from './projects.controller.js';
import {
  projectIdParam,
  createProjectSchema,
  updateProjectSchema,
  patchProjectSchema,
} from './projects.schema.js';

export default async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/', { schema: createProjectSchema, preHandler: [fastify.requireActiveUser] }, projectController.create);
  fastify.get('/', { preHandler: [fastify.requireActiveUser] }, projectController.list);
  fastify.get('/:id', { schema: { params: projectIdParam }, preHandler: [fastify.optionalAuth] }, projectController.get);
  fastify.put('/:id', { schema: updateProjectSchema, preHandler: [fastify.requireActiveUser] }, projectController.update);
  fastify.patch('/:id', { schema: patchProjectSchema, preHandler: [fastify.requireActiveUser] }, projectController.patch);
  fastify.delete('/:id', { schema: { params: projectIdParam }, preHandler: [fastify.requireActiveUser] }, projectController.remove);
  fastify.get('/share/:id', { schema: { params: projectIdParam } }, projectController.getShare);
  fastify.post('/clone/:id', { schema: { params: projectIdParam }, preHandler: [fastify.requireActiveUser] }, projectController.clone);
}
