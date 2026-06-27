import 'dotenv/config';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Fastify from 'fastify';
import mongoose from './plugins/mongoose.js';
import cron from './plugins/cron.js';
import cors from './plugins/cors.js';
import socket from './plugins/socket.js';
import helmet from './plugins/helmet.js';
import rateLimit from './plugins/rateLimit.js';
import auth from './plugins/auth.js';
import mercurius from 'mercurius';
import { NoSchemaIntrospectionCustomRule } from 'graphql';
import { createDepthLimitRule } from './graphql/depth-limit.js';
import { schema } from './graphql/schema.js';
import { resolvers } from './graphql/resolvers.js';
import { loaders } from './graphql/loaders.js';
import fastifyCookie from '@fastify/cookie';

import authRoutes from './modules/auth/auth.routes.js';
import projectRoutes from './modules/projects/projects.routes.js';
import lyricsRoutes from './modules/lyrics/lyrics.routes.js';
import uploadRoutes from './modules/uploads/uploads.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import songMetadataRoutes from './modules/song-metadata/song-metadata.routes.js';
import { googleRoutes } from './modules/google/google.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import youtubeRoutes from './modules/youtube/youtube.routes.js';
import geniusRoutes from './modules/genius/genius.routes.js';
import healthRoutes from './modules/health/health.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import ogRoutes from './modules/og/og.routes.js';

const envToLogger: Record<string, Record<string, unknown>> = {
  development: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    },
  },
  production: { level: 'warn' },
};

async function build() {
  const app = Fastify({
    logger: envToLogger[process.env.NODE_ENV as string] ?? envToLogger.production,
    trustProxy: true,
  });

  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET,
  });
  await app.register(helmet);
  await app.register(cors);
  await app.register(socket);
  await app.register(rateLimit);
  await app.register(mongoose);
  await app.register(cron);
  await app.register(auth);

  await app.register(mercurius, {
    schema,
    resolvers,
    loaders,
    context: async (request: FastifyRequest) => {
      // Run optionalAuth so request.userId is populated for authenticated GraphQL requests.
      await app.optionalAuth(request, {} as FastifyReply);
      return {
        userId: request.userId,
        bannedUserId: (request as FastifyRequest & { bannedUserId?: string }).bannedUserId,
        ip: request.ip,
        tokenExpired: (request as FastifyRequest & { tokenExpired?: boolean }).tokenExpired ?? false,
        socketId: request.headers['x-socket-id'] as string | undefined
      };
    },
    graphiql: process.env.NODE_ENV === 'development',
    // Depth limiting applies in every environment; introspection stays disabled
    // outside development. 12 comfortably covers legitimate nested queries while
    // blocking abusive deep traversals (Project.user → User.projects → …).
    validationRules: process.env.NODE_ENV !== 'development'
      ? [NoSchemaIntrospectionCustomRule, createDepthLimitRule(12)]
      : [createDepthLimitRule(12)],
    errorFormatter: (result, ctx) => {
      const formatted = mercurius.defaultErrorFormatter(result, ctx);
      if (formatted.response.errors) {
        formatted.response.errors = formatted.response.errors.map(err => ({
          ...err,
          message: err.message.replace(/\s*Did you mean.*?\?/gi, ''),
        }));
      }
      return formatted;
    },
  });

  app.setErrorHandler((error, request, reply) => {
    const err = error as Error & { validation?: { keyword: string; params?: { missingProperty?: string } }[]; statusCode?: number };
    if (err.validation) {
      const missingHeaders = err.validation.filter(
        (v) => v.keyword === 'required' && v.params?.missingProperty
      );
      if (missingHeaders.length > 0) {
        return reply.code(400).send({ error: 'Missing required header: ' + missingHeaders[0].params?.missingProperty });
      }
      return reply.code(400).send({ error: 'validation_error' });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    if (err.statusCode === 413) {
      return reply.code(413).send({ error: 'payload_too_large' });
    }
    request.log.error({ err: error, url: request.url, method: request.method }, 'Unhandled error');
    return reply.code(err.statusCode || 500).send({ error: 'server_error' });
  });

  if (process.env.NODE_ENV === 'development') {
    app.addHook('preHandler', async (request: FastifyRequest) => {
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        request.log.info({
          method: request.method,
          url: request.url,
          body: request.body,
        }, 'Request Body');
      }
    });
  }

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(projectRoutes, { prefix: '/projects' });
  await app.register(uploadRoutes, { prefix: '/uploads' });
  await app.register(songMetadataRoutes, { prefix: '/song-metadata' });
  await app.register(googleRoutes, { prefix: '/google' });
  await app.register(settingsRoutes, { prefix: '/settings' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(youtubeRoutes, { prefix: '/youtube' });

  await app.register(lyricsRoutes, { prefix: '/lyrics' });
  await app.register(lyricsRoutes, { prefix: '/editor' });
  await app.register(geniusRoutes, { prefix: '/lyrics' });

  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(notificationsRoutes, { prefix: '/notifications' });
  await app.register(ogRoutes, { prefix: '/og' });

  return app;
}

(async () => {
  const app = await build();
  try {
    const port = parseInt(process.env.PORT as string, 10) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
})();