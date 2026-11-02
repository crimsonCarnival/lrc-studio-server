import type { FastifyInstance } from 'fastify';
import * as lyricsController from './lyrics.controller.js';
import {
  parseSchema,
  compileLrcSchema,
  compileSrtSchema,
  inferEndTimesSchema,
} from './lyrics.schema.js';

export default async function lyricsRoutes(fastify: FastifyInstance) {
  fastify.post('/parse', { schema: parseSchema }, lyricsController.parse);
  // optionalAuth: a signed-in user's saved export settings supply defaults the body omits.
  fastify.post('/compile/lrc', { schema: compileLrcSchema, preHandler: [fastify.optionalAuth] }, lyricsController.compileLrc);
  fastify.post('/compile/srt', { schema: compileSrtSchema }, lyricsController.compileSrt);
  fastify.post('/infer-end-times', { schema: inferEndTimesSchema }, lyricsController.inferEnd);
}