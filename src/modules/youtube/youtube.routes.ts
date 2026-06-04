import type { FastifyInstance } from 'fastify';
import { searchYoutube, checkEmbed } from './youtube.controller.js';

export default async function youtubeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/search', searchYoutube);
  fastify.get('/check-embed', checkEmbed);
}