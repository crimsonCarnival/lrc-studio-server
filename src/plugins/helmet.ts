import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifyHelmet from '@fastify/helmet';

async function helmetPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: { policy: 'unsafe-none' },
  });
}

export default fp(helmetPlugin, { name: 'helmet' });