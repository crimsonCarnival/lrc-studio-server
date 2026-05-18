import type { FastifyRequest, FastifyReply } from 'fastify';
import * as googleService from './google.service.js';
import * as authService from '../auth/auth.service.js';

function callbackHtml(success: boolean, error?: string | null): string {
  const payload = { type: 'google-callback', success, error: error || null };
  const payloadStr = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head><title>Google</title></head><body>
<script>
  if (window.opener) {
    window.opener.postMessage(${payloadStr}, '*');
  }
  window.close();
</script>
<p>${success ? 'Connected! This window will close.' : `Error: ${error || 'Unknown'}`}</p>
</body></html>`;
}

export async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!googleService.isGoogleConfigured()) {
    return reply.code(503).send({ error: 'Google OAuth integration not configured' });
  }
  const state = googleService.generateSignedState({ sub: req.userId!, action: 'connect' });
  return reply.send({ url: googleService.getAuthUrl(state) });
}

export async function authorizeLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!googleService.isGoogleConfigured()) {
    return reply.code(503).send({ error: 'Google OAuth integration not configured' });
  }
  const state = googleService.generateSignedState({ action: 'login' });
  return reply.send({ url: googleService.getAuthUrl(state) });
}

export async function callback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) {
    return reply.type('text/html').send(callbackHtml(false, error));
  }

  if (!code || !state) {
    return reply.code(400).type('text/html').send(callbackHtml(false, 'Missing code or state'));
  }

  const statePayload = googleService.verifySignedState(state);
  if (!statePayload) {
    return reply.code(400).type('text/html').send(callbackHtml(false, 'invalid_state'));
  }

  const action = statePayload.action as string;

  if (action === 'connect') {
    // Account linking flow
    const userId = statePayload.sub as string;
    const result = await googleService.handleCallback(code, userId);
    if ((result as Record<string, unknown>).error) {
      return reply.code((result as Record<string, number>).status).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error));
    }
    return reply.type('text/html').send(callbackHtml(true));
  }

  if (action === 'login') {
    // Sign-in flow
    const result = await googleService.handleLoginCallback(code);
    if ((result as Record<string, unknown>).error) {
      return reply.code((result as Record<string, number>).status).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error));
    }

    // Get tokens and set cookies
    const userId = (result as Record<string, unknown>).userId as string;
    const deviceId = (req.headers['x-device-id'] as string) || 'unknown';
    
    // @ts-ignore - this refers to FastifyInstance
    const tokens = await authService.loginByUserId(userId, this.jwt, req.ip, deviceId);

    if (!tokens || (tokens as any).error) {
      return reply.code(500).type('text/html').send(callbackHtml(false, (tokens as any).error || 'Failed to create session'));
    }

    const cookieOpts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' as const : 'lax' as const,
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    };

    reply.setCookie('accessToken', (tokens as Record<string, string>).accessToken, cookieOpts);
    reply.setCookie('refreshToken', (tokens as Record<string, string>).refreshToken, cookieOpts);

    return reply.type('text/html').send(callbackHtml(true));
  }

  return reply.code(400).type('text/html').send(callbackHtml(false, 'Invalid action'));
}

export async function disconnect(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await googleService.disconnectGoogle(req.userId!);
  if ((result as Record<string, unknown>).error) {
    return reply.code((result as Record<string, number>).status).send({
      error: (result as Record<string, unknown>).error,
      message: (result as Record<string, unknown>).message,
    });
  }
  return reply.send(result);
}
