import type { FastifyInstance } from 'fastify';
import * as uploadController from './uploads.controller.js';
import { signatureSchema, createMediaSchema, updateMediaSchema, listMediaSchema } from './uploads.schema.js';

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
  fastify.get('/media', { schema: listMediaSchema, preHandler: [fastify.requireActiveUser] }, uploadController.listMedia);
  fastify.get('/media/:id', { preHandler: [fastify.requireActiveUser] }, uploadController.getMedia);
  // Guests can persist YouTube/Cloudinary records (userId will be null in the DB).
  fastify.post('/media', { schema: createMediaSchema, preHandler: [fastify.optionalAuth] }, uploadController.createMedia);
  fastify.patch('/media/:id', { schema: updateMediaSchema, preHandler: [fastify.requireActiveUser] }, uploadController.updateMedia);
  fastify.delete('/media/:id', { preHandler: [fastify.requireActiveUser] }, uploadController.deleteMedia);
}