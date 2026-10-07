import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifyCors from '@fastify/cors';
import { parseAllowedOrigins } from '../config/allowed-origins.js';

async function corsPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = parseAllowedOrigins(process.env.CORS_ORIGIN);

  await fastify.register(fastifyCors, {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Socket-Id'],
  });
}

export default fp(corsPlugin, { name: 'cors' });