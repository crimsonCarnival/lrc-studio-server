import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as authController from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  checkIdentifierSchema,
  refreshSchema,
  updateProfileSchema,
} from './auth.schema.js';

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: 'validation_error' });
    }
    if (error.statusCode === 429) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    request.log.error(error);
    return reply.code(error.statusCode || 500).send({ error: 'server_error' });
  });

  // Auth-sensitive routes key the limiter on IP ALONE. The global limiter keys on
  // `${ip}-${deviceId}`, but `x-device-id` is a client-supplied header — rotating
  // it yields a fresh bucket per request and defeats brute-force/credential-stuffing
  // protection. For these routes the device dimension must not be trusted.
  const ipOnlyKey = (req: FastifyRequest) => req.ip;
  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: ipOnlyKey } } };
  const strictRateLimit = { config: { rateLimit: { max: 3, timeWindow: '1 hour', keyGenerator: ipOnlyKey } } };

  fastify.post('/register', { schema: registerSchema, ...strictRateLimit }, authController.register);
  fastify.post('/login', { schema: loginSchema, ...authRateLimit }, authController.login);
  fastify.post('/check-identifier', { schema: checkIdentifierSchema, ...authRateLimit }, authController.checkIdentifier);
  fastify.post('/refresh', { schema: refreshSchema }, authController.refresh);
  fastify.post('/logout', { preHandler: [fastify.optionalAuth] }, authController.logout);
  fastify.get('/me', { preHandler: [fastify.requireAuth] }, authController.me);
  fastify.patch('/profile', { schema: updateProfileSchema, preHandler: [fastify.requireAuth] }, authController.updateProfile);
  fastify.post('/appeal', { preHandler: [fastify.requireAuthForAppeal] }, authController.submitAppeal);
  fastify.post('/clear-unban-message', { preHandler: [fastify.requireAuthLax] }, authController.clearUnbanMessage);
  fastify.post('/forgot-password', { ...authRateLimit }, authController.forgotPassword);
  fastify.get('/reset-password/validate', { ...authRateLimit }, authController.validateResetPasswordToken);
  fastify.post('/reset-password', { ...authRateLimit }, authController.resetPasswordEndpoint);
  fastify.post('/change-password', { preHandler: [fastify.requireAuth] }, authController.changePassword);
  fastify.post('/set-password', { preHandler: [fastify.requireAuth] }, authController.setPassword);
  fastify.post('/send-verification', { preHandler: [fastify.requireAuth], config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: ipOnlyKey } } }, authController.sendVerificationEmailHandler);
  fastify.post('/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: ipOnlyKey } } }, authController.verifyEmailHandler);
  fastify.get('/sessions', { preHandler: [fastify.requireAuth] }, authController.getSessions);
  fastify.delete('/sessions/:id', { preHandler: [fastify.requireAuth] }, authController.revokeSession);
  fastify.post('/logout-all', { preHandler: [fastify.requireAuth] }, authController.logoutAll);

  // Passkey / WebAuthn Routes
  fastify.get('/passkey/register/options', { preHandler: [fastify.requireAuth] }, authController.generateRegistrationOptionsHandler);
  fastify.post('/passkey/register/verify', { preHandler: [fastify.requireAuth] }, authController.verifyRegistrationResponseHandler);
  fastify.post('/passkey/login/options', { ...authRateLimit }, authController.generateAuthenticationOptionsHandler);
  fastify.post('/passkey/login/verify', { ...authRateLimit }, authController.verifyAuthenticationResponseHandler);
  
  // Passkey Management
  fastify.get('/passkeys', { preHandler: [fastify.requireAuth] }, authController.getPasskeys);
  fastify.delete('/passkeys/:id', { preHandler: [fastify.requireAuth] }, authController.deletePasskey);

  fastify.post('/deactivate', { preHandler: [fastify.requireAuth] }, authController.deactivate);
}