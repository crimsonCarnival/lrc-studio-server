import type { FastifyInstance } from 'fastify';
import { getHealth } from './health.service.js';

export default async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/live', async () => ({ status: 'ok' }));

  fastify.get('/ready', async (_req, reply) => {
    const health = await getHealth();
    const code = health.checks.database.status === 'error' ? 503 : 200;
    return reply.code(code).send({
      status: health.status,
      checks: { database: health.checks.database },
    });
  });

  fastify.get('/', async (_req, reply) => {
    const health = await getHealth();
    const code = health.status === 'error' ? 503 : 200;
    return reply.code(code).send(health);
  });
}
