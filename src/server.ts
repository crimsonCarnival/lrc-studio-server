import 'dotenv/config';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import Fastify from 'fastify';
import mongoose from './plugins/mongoose.js';
import cron from './plugins/cron.js';
import cors from './plugins/cors.js';
import socket from './plugins/socket.js';
import collab from './plugins/collab.js';
import helmet from './plugins/helmet.js';
import rateLimit from './plugins/rate-limit.js';
import csrf from './plugins/csrf.js';
import auth, { verifyAdminSudo } from './plugins/auth.js';
import mercurius from 'mercurius';
import { NoSchemaIntrospectionCustomRule } from 'graphql';
import { createDepthLimitRule } from './graphql/depth-limit.js';
import { schema } from './graphql/schema.js';
import { resolvers } from './graphql/resolvers.js';
import { loaders } from './graphql/loaders.js';
import fastifyCookie from '@fastify/cookie';
import { handleFastifyError } from './shared/error-handler.js';
import { getEnv, toFastifyTrustProxy } from './config/env.js';

import authRoutes from './modules/auth/auth.routes.js';
import lyricsRoutes from './modules/lyrics/lyrics.routes.js';
import uploadRoutes from './modules/uploads/uploads.routes.js';
import songMetadataRoutes from './modules/song-metadata/song-metadata.routes.js';
import { googleRoutes } from './modules/google/google.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import youtubeRoutes from './modules/youtube/youtube.routes.js';
import geniusRoutes from './modules/genius/genius.routes.js';
import healthRoutes from './modules/health/health.routes.js';
import rootRoutes from './modules/root/root.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import ogRoutes from './modules/og/og.routes.js';
import asrRoutes from './modules/asr/asr.routes.js';
import { deriveErrorCode } from './graphql/error-code.js';

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

// Resolvers signal expected failures with plain Error messages the client
// reads ('not_found', 'Unauthorized', ...), so only these classes are masked:
// their messages carry query shapes, paths and driver detail.
const INTERNAL_ERROR_NAMES = new Set([
  'CastError', 'ValidationError', 'MongooseError', 'MongoServerError', 'MongoError',
  'TransactionError', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
]);

function isInternalError(err: Error | undefined): boolean {
  return process.env.NODE_ENV === 'production' && !!err && INTERNAL_ERROR_NAMES.has(err.name);
}

async function build() {
  const app = Fastify({
    logger: envToLogger[process.env.NODE_ENV as string] ?? envToLogger.production,
    // See env.TRUST_PROXY — `true` lets a direct caller choose request.ip.
    trustProxy: toFastifyTrustProxy(getEnv().TRUST_PROXY),
    // JSON/text bodies only — audio uploads go client→Cloudinary directly via
    // signed URL and never pass through this limit. 5MB comfortably covers a
    // full-project PATCH (large words-mode projects with translations).
    bodyLimit: 5 * 1024 * 1024,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
  reply.removeHeader('X-Powered-By');
  return payload;
});

  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET,
  });
  await app.register(helmet);
  await app.register(cors);
  await app.register(csrf);
  await app.register(socket);
  await app.register(rateLimit);
  await app.register(mongoose);
  await app.register(cron);
  await app.register(auth);
  // After socket (destroyUpgrade: false) and mongoose: collab owns non-Socket.IO
  // upgrades, and its onClose must flush pending stores before Mongo closes.
  await app.register(collab);
  
  

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
        socketId: request.headers['x-socket-id'] as string | undefined,
        deviceId: request.headers['x-device-id'] as string | undefined,
        // Resolved per request from the httpOnly adminSudo cookie; resolvers that
        // gate sudo-protected actions check this flag, never the raw token.
        hasSudo: verifyAdminSudo(request.cookies.adminSudo, request.userId),
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
        const originals = result.errors ?? [];
        // A banned caller has no userId in context (optionalAuth sets bannedUserId instead), so
        // auth guards answer "Unauthorized". Telling the client its session expired would send it
        // into refresh/logout and away from the ban screen; mark those errors `banned` instead.
        const banned = Boolean(
          (ctx as { bannedUserId?: string }).bannedUserId
          ?? (ctx.reply?.request as { bannedUserId?: string } | undefined)?.bannedUserId,
        );
        // Index pairing with result.errors assumes no original error carries a nested `errors`
        // array (defaultErrorFormatter flattens those); only validation errors do, and they have no code.
        formatted.response.errors = formatted.response.errors.map((err, i) => {
          const original = originals[i]?.originalError;
          const code = deriveErrorCode(original, { banned });
          return {
            ...err,
            message: isInternalError(original)
              ? 'internal_error'
              : err.message.replace(/\s*Did you mean.*?\?/gi, ''),
            // Resolver errors travel as HTTP 200, so the client branches on this code, not a status.
            ...(code ? { extensions: { ...err.extensions, code } } : {}),
          };
        });
      }
      return formatted;
    },
  });

  app.setErrorHandler(handleFastifyError);

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

  // /projects and /settings are GraphQL-only. Their REST modules duplicated
  // the resolvers' ownership and permission checks with no caller, so they
  // were retired rather than left as a second, unexercised authz path.
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(uploadRoutes, { prefix: '/uploads' });
  await app.register(songMetadataRoutes, { prefix: '/song-metadata' });
  await app.register(googleRoutes, { prefix: '/google' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(youtubeRoutes, { prefix: '/youtube' });

  await app.register(lyricsRoutes, { prefix: '/lyrics' });
  await app.register(geniusRoutes, { prefix: '/lyrics' });

  await app.register(rootRoutes);
  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(notificationsRoutes, { prefix: '/notifications' });
  await app.register(ogRoutes, { prefix: '/og' });
  await app.register(asrRoutes, { prefix: '/asr' });

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