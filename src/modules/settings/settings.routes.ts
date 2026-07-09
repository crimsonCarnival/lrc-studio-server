import type { FastifyInstance } from 'fastify';
import * as settingsController from './settings.controller.js';
import { handleFastifyError } from '../../shared/errorHandler.js';
import { settingsBodySchema } from './settings.schema.js';

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(handleFastifyError);

  app.get('/', { preHandler: [app.requireAuth] }, settingsController.get);
  app.put('/', { schema: { body: settingsBodySchema }, preHandler: [app.requireAuth] }, settingsController.replace);
  app.patch('/', { schema: { body: settingsBodySchema }, preHandler: [app.requireAuth] }, settingsController.patch);
  app.delete('/', { preHandler: [app.requireAuth] }, settingsController.reset);
}