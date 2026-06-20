import type { FastifyRequest, FastifyReply } from 'fastify';
import type { CookieSerializeOptions } from '@fastify/cookie';
import * as authService from './auth.service.js';
import type { UpdateProfileData } from './auth.service.js';
import { requestPasswordReset, validateResetToken, resetPassword, changePassword as changePasswordService, PasswordResetError } from '../password-reset/password-reset.service.js';
import { resendVerification, verifyEmailToken, VerificationError } from '../email-verification/email-verification.service.js';
import { verifyRecaptcha } from './auth.service.js';
import { getEnv } from '../../config/env.js';

/** Parse JWT duration strings ("30m", "1d", "2h") to seconds. */
function parseExpiry(str: string | undefined, fallbackSeconds: number): number {
  if (!str) return fallbackSeconds;
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  return fallbackSeconds;
}

const env = getEnv();
const ACCESS_COOKIE_MAX_AGE = parseExpiry(env.JWT_ACCESS_EXPIRY, 30 * 60);
const REFRESH_COOKIE_MAX_AGE = parseExpiry(env.JWT_REFRESH_EXPIRY, 24 * 60 * 60);

const cookieOptions: CookieSerializeOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/',
};

function setAuthCookies(reply: FastifyReply, result: { accessToken?: string; refreshToken?: string }) {
  if (result.accessToken) {
    reply.setCookie('accessToken', result.accessToken, { ...cookieOptions, maxAge: ACCESS_COOKIE_MAX_AGE });
  }
  if (result.refreshToken) {
    reply.setCookie('refreshToken', result.refreshToken, { ...cookieOptions, maxAge: REFRESH_COOKIE_MAX_AGE });
  }
}

function clearAuthCookies(reply: FastifyReply) {
  reply.clearCookie('accessToken', cookieOptions);
  reply.clearCookie('refreshToken', cookieOptions);
}

const VALID_DEVICE_PREFIXES = ['dv_fp_', 'dv_fallback_'];

function extractDeviceId(req: FastifyRequest, reply: FastifyReply): string | null {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId || typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    reply.code(400).send({ error: 'Missing required header: x-device-id' });
    return null;
  }
  const trimmed = deviceId.trim().slice(0, 256);
  if (!VALID_DEVICE_PREFIXES.some(p => trimmed.startsWith(p))) {
    reply.code(400).send({ error: 'Invalid device identifier format.' });
    return null;
  }
  return trimmed;
}

export async function register(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deviceId = extractDeviceId(req, reply);
  if (!deviceId) return;
  const body = req.body as {
    accountName?: string;
    displayName?: string;
    email?: string;
    password: string;
    recaptchaToken?: string;
  };
  const userAgent = (req.headers['user-agent'] as string) || '';
  const platformVersion = (req.headers['sec-ch-ua-platform-version'] as string) || undefined;
  const result = await authService.register(
    {
      accountName: body.accountName,
      displayName: body.displayName,
      email: body.email,
      password: body.password,
      recaptchaToken: body.recaptchaToken,
      userAgent,
      platformVersion,
    },
    req.server.jwt,
    req.ip,
    deviceId
  );
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }

  setAuthCookies(reply, result as { accessToken?: string; refreshToken?: string });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...responseData } = result as Record<string, unknown>;
  return reply.code(201).send(responseData);
}

export async function login(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deviceId = extractDeviceId(req, reply);
  if (!deviceId) return;
  const body = req.body as {
    identifier: string;
    password: string;
    recaptchaToken?: string;
  };
  const userAgent = (req.headers['user-agent'] as string) || '';
  const platformVersion = (req.headers['sec-ch-ua-platform-version'] as string) || undefined;
  const result = await authService.login(
    {
      identifier: body.identifier,
      password: body.password,
      recaptchaToken: body.recaptchaToken,
      userAgent,
      platformVersion,
    },
    req.server.jwt,
    req.ip,
    deviceId
  );
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }

  setAuthCookies(reply, result as { accessToken?: string; refreshToken?: string });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...responseData } = result as Record<string, unknown>;
  return reply.send(responseData);
}

export async function checkIdentifier(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deviceId = extractDeviceId(req, reply);
  if (!deviceId) return;
  const result = await authService.checkIdentifier((req.body as Record<string, string>).identifier, req.ip, deviceId);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }
  return reply.send(result);
}

export async function refresh(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deviceId = extractDeviceId(req, reply);
  if (!deviceId) return;
  
  const tokenToRefresh = req.cookies.refreshToken;
  if (!tokenToRefresh) {
    return reply.code(401).send({ error: 'token_expired', code: 'token_expired' });
  }

  const result = await authService.refresh(tokenToRefresh, req.server.jwt, req.ip, deviceId);
  if (result.error) {
    clearAuthCookies(reply);
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }

  setAuthCookies(reply, result as { accessToken?: string; refreshToken?: string });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...responseData } = result as Record<string, unknown>;
  return reply.send(responseData);
}

export async function logout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const refreshToken = req.cookies.refreshToken;
  let familyId: string | undefined;
  if (refreshToken) {
    try {
      const decoded = req.server.jwt.verifyToken(refreshToken) as Record<string, unknown>;
      familyId = decoded.familyId as string | undefined;
    } catch {}
  }
  
  if (req.userId) {
    await authService.logout(req.userId, familyId);
  }
  
  clearAuthCookies(reply);
  return reply.send({ success: true });
}

export async function me(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deviceId = req.headers['x-device-id'];
  const result = await authService.getProfile(req.userId!, req.ip, deviceId as string | undefined);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }
  return reply.send(result);
}

export async function updateProfile(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.updateProfile(req.userId!, req.body as UpdateProfileData, req.log);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }
  return reply.send(result);
}

export async function submitAppeal(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.submitAppeal(req.userId!, (req.body as Record<string, string>).appealText);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }
  return reply.send(result);
}

export async function clearUnbanMessage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.clearUnbanMessage(req.userId!);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }
  return reply.send(result);
}

export async function forgotPassword(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { email, recaptchaToken } = req.body as { email?: string; recaptchaToken?: string };

  if (!email) {
    return reply.code(400).send({ error: 'Email is required' });
  }

  if (!(await verifyRecaptcha(recaptchaToken, req.ip))) {
    return reply.code(403).send({ error: 'recaptcha_failed', code: 'recaptcha_failed' });
  }

  try {
    await requestPasswordReset(email);
  } catch (err) {
    if (err instanceof PasswordResetError && err.status === 429) {
      return reply.code(429).send({ error: 'Too many requests' });
    }
    console.error('Forgot password error:', err);
  }

  // Always return success (no enumeration)
  return reply.code(200).send({
    success: true,
    message: 'If an account exists for this email, a reset link has been sent.',
  });
}

export async function validateResetPasswordToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { token } = req.query as { token?: string };

  if (!token) {
    return reply.code(400).send({ error: 'Token is required' });
  }

  try {
    const { email } = await validateResetToken(token);
    return reply.code(200).send({ valid: true, email });
  } catch (err) {
    if (err instanceof PasswordResetError) {
      return reply.code(200).send({ valid: false, reason: 'invalid' });
    }
    return reply.code(200).send({ valid: false, reason: 'error' });
  }
}

export async function resetPasswordEndpoint(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { token, newPassword, confirmPassword } = req.body as { token?: string; newPassword?: string; confirmPassword?: string };

  if (!token || !newPassword || !confirmPassword) {
    return reply.code(400).send({ error: 'All fields required' });
  }

  if (newPassword !== confirmPassword) {
    return reply.code(400).send({ error: 'Passwords do not match' });
  }

  try {
    await resetPassword(token, newPassword);
    return reply.code(200).send({ success: true, message: 'Password reset successfully.' });
  } catch (err) {
    if (err instanceof PasswordResetError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    return reply.code(500).send({ error: 'Server error' });
  }
}

export async function changePassword(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.userId) {
    return reply.code(403).send({ error: 'Unauthorized' });
  }

  const { currentPassword, newPassword, confirmPassword } = req.body as { currentPassword?: string; newPassword?: string; confirmPassword?: string };

  if (!currentPassword || !newPassword || !confirmPassword) {
    return reply.code(400).send({ error: 'All fields required' });
  }

  if (newPassword !== confirmPassword) {
    return reply.code(400).send({ error: 'Passwords do not match' });
  }

  try {
    await changePasswordService(req.userId, currentPassword, newPassword);
    return reply.code(200).send({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    if (err instanceof PasswordResetError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    return reply.code(500).send({ error: 'Server error' });
  }
}

export async function setPassword(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.userId) {
    return reply.code(403).send({ error: 'Unauthorized' });
  }

  const { newPassword, confirmPassword } = req.body as { newPassword?: string; confirmPassword?: string };

  if (!newPassword || !confirmPassword) {
    return reply.code(400).send({ error: 'All fields required' });
  }

  if (newPassword !== confirmPassword) {
    return reply.code(400).send({ error: 'Passwords do not match' });
  }

  try {
    await changePasswordService(req.userId, null, newPassword, true);
    return reply.code(200).send({ success: true, message: 'Password set successfully.' });
  } catch (err) {
    if (err instanceof PasswordResetError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    return reply.code(500).send({ error: 'Server error' });
  }
}

export async function sendVerificationEmailHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await resendVerification(req.userId!);
  } catch (err) {
    if (err instanceof VerificationError) {
      return reply.code(err.status).send({ error: err.code });
    }
    return reply.code(500).send({ error: 'server_error' });
  }
  return reply.send({ success: true });
}

export async function verifyEmailHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { token } = req.body as { token?: string };
  if (!token) {
    return reply.code(400).send({ error: 'missing_token' });
  }
  try {
    await verifyEmailToken(token);
    return reply.send({ success: true });
  } catch (err) {
    const code = err instanceof VerificationError ? err.code : 'server_error';
    return reply.code(400).send({ error: code });
  }
}

// ─── Session Management Handlers ───────────────────────────────────────────────

export async function getSessions(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies.accessToken;
  let currentFamilyId: string | undefined;
  if (token) {
    try {
      const decoded = req.server.jwt.verifyToken(token) as Record<string, unknown>;
      currentFamilyId = decoded.familyId as string | undefined;
    } catch {}
  }

  const currentUA = (req.headers['user-agent'] as string) || '';
  const currentPlatformVersion = (req.headers['sec-ch-ua-platform-version'] as string) || undefined;
  const result = await authService.getSessions(req.userId!, currentFamilyId, currentUA, currentPlatformVersion);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.send(result);
}

export async function revokeSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = req.params as { id: string };
  if (!id || !/^[a-f\d]{24}$/i.test(id)) {
    return reply.code(400).send({ error: 'invalid_session_id' });
  }
  const result = await authService.revokeSession(req.userId!, id);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }
  return reply.send(result);
}

export async function logoutAll(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = req.body as { keepCurrent?: boolean } | undefined;
  const keepCurrent = body?.keepCurrent === true;

  let currentFamilyId: string | undefined;
  if (keepCurrent) {
    const token = req.cookies.accessToken;
    if (token) {
      try {
        const decoded = req.server.jwt.verifyToken(token) as Record<string, unknown>;
        currentFamilyId = decoded.familyId as string | undefined;
      } catch {}
    }
  }

  await authService.revokeAllSessions(req.userId!, keepCurrent ? currentFamilyId : undefined);

  if (!keepCurrent) {
    clearAuthCookies(reply);
  }

  return reply.send({ success: true });
}

// ─── WebAuthn / Passkeys ─────────────────────────────────────────────────────

export async function generateRegistrationOptionsHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.getPasskeyRegistrationOptions(req.userId!);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.send(result);
}

export async function verifyRegistrationResponseHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const userAgent = (req.headers['user-agent'] as string) || '';
  const secCHUAPlatformVersion = (req.headers['sec-ch-ua-platform-version'] as string) || undefined;
  const result = await authService.verifyPasskeyRegistration(
    req.userId!,
    req.body as import('@simplewebauthn/server').RegistrationResponseJSON,
    userAgent,
    secCHUAPlatformVersion
  );
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.send(result);
}

export async function generateAuthenticationOptionsHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { identifier } = req.body as { identifier: string };
  if (!identifier) {
    return reply.code(400).send({ error: 'identifier_required' });
  }
  const result = await authService.getPasskeyLoginOptions(identifier);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.send(result);
}

export async function verifyAuthenticationResponseHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const deviceId = extractDeviceId(req, reply);
  if (!deviceId) return;
  
  const { identifier, response } = req.body as { identifier: string; response: import('@simplewebauthn/server').AuthenticationResponseJSON };
  const userAgent = (req.headers['user-agent'] as string) || '';

  const result = await authService.verifyPasskeyLogin(
    identifier,
    response,
    req.server.jwt,
    req.ip,
    deviceId,
    userAgent
  );

  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error, code: result.code });
  }

  setAuthCookies(reply, result as { accessToken?: string; refreshToken?: string });
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...responseData } = result as Record<string, unknown>;
  return reply.send(responseData);
}

export async function getPasskeys(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.getPasskeysForUser(req.userId!);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.send(result);
}

export async function deletePasskey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { id } = req.params as { id: string };
  if (!id || !/^[a-f\d]{24}$/i.test(id)) {
    return reply.code(400).send({ error: 'invalid_passkey_id' });
  }
  const result = await authService.deletePasskeyForUser(req.userId!, id);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  return reply.send(result);
}

export async function deactivate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await authService.deactivateUser(req.userId!);
  if (result.error) {
    return reply.code(result.status || 500).send({ error: result.error });
  }
  clearAuthCookies(reply);
  return reply.send({ success: true });
}