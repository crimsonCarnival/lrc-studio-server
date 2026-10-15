import type { FastifyInstance } from 'fastify';
import * as lyricsController from './lyrics.controller.js';
import {
  parseSchema,
  compileLrcSchema,
  compileSrtSchema,
  inferEndTimesSchema,
  markSchema,
  bulkShiftSchema,
  globalOffsetSchema,
  clearAllSchema,
  clearLineSchema,
  detectDuplicatesSchema,
} from './lyrics.schema.js';

export default async function lyricsRoutes(fastify: FastifyInstance) {
  // --- Parse / Compile (prefix: /lyrics) -------------------------------
  fastify.post('/parse', { schema: parseSchema }, lyricsController.parse);
  // optionalAuth: a signed-in user's saved export settings supply defaults the body omits.
  fastify.post('/compile/lrc', { schema: compileLrcSchema, preHandler: [fastify.optionalAuth] }, lyricsController.compileLrc);
  fastify.post('/compile/srt', { schema: compileSrtSchema }, lyricsController.compileSrt);
  fastify.post('/infer-end-times', { schema: inferEndTimesSchema }, lyricsController.inferEnd);

  // --- Editor operations (prefix: /editor) -----------------------------
  fastify.post('/mark', { schema: markSchema }, lyricsController.mark);
  fastify.post('/bulk-shift', { schema: bulkShiftSchema }, lyricsController.bulkShift);
  fastify.post('/global-offset', { schema: globalOffsetSchema }, lyricsController.globalOffset);
  fastify.post('/clear-all', { schema: clearAllSchema }, lyricsController.clearAll);
  fastify.post('/clear-line', { schema: clearLineSchema }, lyricsController.clearLine);
  fastify.post('/detect-duplicates', { schema: detectDuplicatesSchema }, lyricsController.detectDuplicates);
}