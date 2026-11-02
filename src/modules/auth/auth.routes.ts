import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as authController from './auth.controller.js';
import { handleFastifyError } from '../../shared/error-handler.js';
import {
  registerSchema,
  loginSchema,
  checkIdentifierSchema,
  refreshSchema,
  forgotPasswordSchema,
  validateResetTokenSchema,
  resetPasswordSchema,
  changePasswordSchema,
  setPasswordSchema,
  verifyEmailSchema,
  appealSchema,
  logoutAllSchema,
} from './auth.schema.js';

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(handleFastifyError);

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
  // `me` and profile updates are GraphQL-only (`me`, `updateProfile`); their REST twins had no caller.
  fastify.post('/appeal', { schema: appealSchema, preHandler: [fastify.requireAuthForAppeal] }, authController.submitAppeal);
  fastify.post('/forgot-password', { schema: forgotPasswordSchema, ...authRateLimit }, authController.forgotPassword);
  fastify.get('/reset-password/validate', { schema: validateResetTokenSchema, ...authRateLimit }, authController.validateResetPasswordToken);
  fastify.post('/reset-password', { schema: resetPasswordSchema, ...authRateLimit }, authController.resetPasswordEndpoint);
  fastify.post('/change-password', { schema: changePasswordSchema, preHandler: [fastify.requireAuth] }, authController.changePassword);
  fastify.post('/set-password', { schema: setPasswordSchema, preHandler: [fastify.requireAuth] }, authController.setPassword);
  fastify.post('/verify-email', { schema: verifyEmailSchema, config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: ipOnlyKey } } }, authController.verifyEmailHandler);
  fastify.get('/sessions', { preHandler: [fastify.requireAuth] }, authController.getSessions);
  fastify.delete('/sessions/:id', { preHandler: [fastify.requireAuth] }, authController.revokeSession);
  fastify.post('/logout-all', { schema: logoutAllSchema, preHandler: [fastify.requireAuth] }, authController.logoutAll);

  // Passkey / WebAuthn Routes
  fastify.get('/passkey/register/options', { preHandler: [fastify.requireAuth] }, authController.generateRegistrationOptionsHandler);
  fastify.post('/passkey/register/verify', { preHandler: [fastify.requireAuth] }, authController.verifyRegistrationResponseHandler);
  fastify.post('/passkey/login/options', { ...authRateLimit }, authController.generateAuthenticationOptionsHandler);
  fastify.post('/passkey/login/verify', { ...authRateLimit }, authController.verifyAuthenticationResponseHandler);
  
  // Passkey Management
  fastify.get('/passkeys', { preHandler: [fastify.requireAuth] }, authController.getPasskeys);
  fastify.delete('/passkeys/:id', { preHandler: [fastify.requireAuth] }, authController.deletePasskey);

  fastify.post('/deactivate', { preHandler: [fastify.requireAuth] }, authController.deactivate);

  // Google OAuth one-time token exchange — public, lightly rate-limited.
  // The OTT is the credential; no auth cookie is required to call this.
  fastify.post('/exchange-ott', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: ipOnlyKey } } }, authController.exchangeOtt);
}