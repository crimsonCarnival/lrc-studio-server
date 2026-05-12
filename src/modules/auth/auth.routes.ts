import type { FastifyInstance } from 'fastify';
import * as authController from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  checkIdentifierSchema,
  refreshSchema,
  updateProfileSchema,
} from './auth.schema.js';

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error: any, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: 'validation_error' });
    }
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    request.log.error(error);
    return reply.code(error.statusCode || 500).send({ error: 'server_error' });
  });

  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const strictRateLimit = { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } };

  fastify.post('/register', { schema: registerSchema, ...strictRateLimit }, authController.register);
  fastify.post('/login', { schema: loginSchema, ...authRateLimit }, authController.login);
  fastify.post('/check-identifier', { schema: checkIdentifierSchema, ...authRateLimit }, authController.checkIdentifier);
  fastify.post('/refresh', { schema: refreshSchema }, authController.refresh);
  fastify.post('/logout', { preHandler: [fastify.optionalAuth] }, authController.logout);
  fastify.get('/me', { preHandler: [fastify.requireAuth] }, authController.me);
  fastify.patch('/profile', { schema: updateProfileSchema, preHandler: [fastify.requireAuth] }, authController.updateProfile);
  fastify.post('/appeal', { preHandler: [fastify.requireAuthForAppeal] }, authController.submitAppeal);
  fastify.post('/clear-unban-message', { preHandler: [fastify.requireAuthLax] }, authController.clearUnbanMessage);
}