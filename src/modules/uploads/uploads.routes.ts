import type { FastifyInstance } from 'fastify';
import * as uploadController from './uploads.controller.js';
import { signatureSchema, updateMediaSchema } from './uploads.schema.js';

export default async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  // Guests (no token) can request a Cloudinary signature and save YouTube/Cloudinary media.
  // optionalAuth populates req.userId when a valid token is present, leaves it null otherwise.
  fastify.post('/signature', { schema: signatureSchema, preHandler: [fastify.optionalAuth] }, uploadController.audioSignature);
  fastify.post('/avatar-signature', {
    preHandler: [fastify.requireAuth],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour'
      }
    }
  }, uploadController.avatarSignature);
  fastify.post('/cover-signature', {
    preHandler: [fastify.requireAuth],
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 hour'
      }
    }
  }, uploadController.coverSignature);
  // Media reads and the create/delete writes are served by GraphQL
  // (uploads / upload / saveMedia / deleteMedia). updateMedia has no GraphQL
  // equivalent yet, so it stays here.
  fastify.patch('/media/:id', { schema: updateMediaSchema, preHandler: [fastify.requireActiveUser] }, uploadController.updateMedia);
}