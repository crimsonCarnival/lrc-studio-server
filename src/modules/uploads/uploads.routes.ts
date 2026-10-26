import type { FastifyInstance } from 'fastify';
import * as uploadController from './uploads.controller.js';
import { signatureSchema, updateMediaSchema } from './uploads.schema.js';

export default async function uploadRoutes(fastify: FastifyInstance): Promise<void> {
  // Authenticated only: the client never uploads audio for guests (useLocalAudio
  // gates on a session), and a signature is reusable until its timestamp
  // expires, so handing them to anonymous callers was free storage for anyone.
  fastify.post('/signature', { schema: signatureSchema, preHandler: [fastify.requireAuth] }, uploadController.audioSignature);
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
  fastify.post('/profile-cover-signature', {
    preHandler: [fastify.requireAuth],
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 hour'
      }
    }
  }, uploadController.profileCoverSignature);
  // Media reads and the create/delete writes are served by GraphQL
  // (uploads / upload / saveMedia / deleteMedia). updateMedia has no GraphQL
  // equivalent yet, so it stays here.
  fastify.patch('/media/:id', { schema: updateMediaSchema, preHandler: [fastify.requireActiveUser] }, uploadController.updateMedia);
}