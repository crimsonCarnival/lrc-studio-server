import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifyCors from '@fastify/cors';

async function corsPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = process.env.CORS_ORIGIN!
    .split(',')
    .map((o: string) => o.trim());

  await fastify.register(fastifyCors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Socket-Id'],
  });
}

export default fp(corsPlugin, { name: 'cors' });