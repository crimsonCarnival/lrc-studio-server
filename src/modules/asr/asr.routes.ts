import type { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { stampFromUpload, stampFromFile, getJobStatus, cancelJobHandler, getJobAudio } from './asr.controller.js';
import { stampJsonSchema } from './asr.schema.js';

export default async function asrRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyMultipart, {
    attachFieldsToBody: false,
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 2 },
  });
  const rateLimit = { max: 10, timeWindow: '1 hour' };
  fastify.post('/stamp', { preHandler: [fastify.requireAuth], schema: stampJsonSchema, config: { rateLimit } }, stampFromUpload);
  fastify.post('/stamp/upload', { preHandler: [fastify.requireAuth], config: { rateLimit } }, stampFromFile);
  fastify.get('/jobs/:id', { preHandler: [fastify.requireAuth] }, getJobStatus);
  fastify.get('/jobs/:id/audio', { preHandler: [fastify.requireAuth] }, getJobAudio);
  fastify.post('/jobs/:id/cancel', { preHandler: [fastify.requireAuth] }, cancelJobHandler);
}
