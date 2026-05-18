import type { FastifyInstance } from 'fastify';
import { search, extract } from './genius.controller.js';

export default async function geniusRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/search', search);
  fastify.get('/extract', extract);
}
