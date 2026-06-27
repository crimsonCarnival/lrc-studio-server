import type { FastifyRequest, FastifyReply } from 'fastify';
import * as googleService from './google.service.js';
import * as authService from '../auth/auth.service.js';
import { getEnv } from '../../config/env.js';
import { jwtTools } from '../../plugins/auth.js';
import { createOtt } from '../auth/ott.service.js';

function callbackHtml(success: boolean, error?: string | null, appOrigin?: string | null, ott?: string | null): string {
  const payload = { type: 'google-callback', success, error: error || null, ott: ott || null };
  const payloadStr = JSON.stringify(payload).replace(/</g, '\\u003c');
  // Use the origin the client passed in state; fall back to primary APP_URL.
  // Avoids '*' wildcard while supporting both dev and prod origins in the same deployment.
  const target = JSON.stringify(appOrigin || getEnv().APP_URL);
  const redirectBase = appOrigin || getEnv().APP_URL;
  const redirectUrl = success
    ? `${redirectBase}/auth/signin?gcb=success${ott ? `&ott=${encodeURIComponent(ott)}` : ''}`
    : `${redirectBase}/auth/signin?gcb=error&gcb_msg=${encodeURIComponent(error || 'OAuth failed')}`;
  return `<!DOCTYPE html><html><head><title>Google</title></head><body>
<script>
  if (window.opener) {
    window.opener.postMessage(${payloadStr}, ${target});
    window.close();
  } else {
    window.location.replace(${JSON.stringify(redirectUrl)});
  }
</script>
<p>${success ? 'Connected! Redirecting...' : `Error: ${error || 'Unknown'}`}</p>
</body></html>`;
}

function resolveAppOrigin(requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const env = getEnv();
  const allowed = new Set([
    ...env.APP_URLS.map(u => new URL(u).origin),
    new URL(env.CORS_ORIGIN.split(',')[0].trim()).origin,
  ]);
  try { return allowed.has(new URL(requested).origin) ? new URL(requested).origin : undefined; } catch { return undefined; }
}

export async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!googleService.isGoogleConfigured()) {
    return reply.code(503).send({ error: 'Google OAuth integration not configured' });
  }
  const { appOrigin: rawOrigin } = req.query as Record<string, string | undefined>;
  const appOrigin = resolveAppOrigin(rawOrigin);
  const state = googleService.generateSignedState({ sub: req.userId!, action: 'connect', appOrigin });
  return reply.redirect(googleService.getAuthUrl(state));
}

export async function authorizeLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!googleService.isGoogleConfigured()) {
    return reply.code(503).send({ error: 'Google OAuth integration not configured' });
  }
  const { appOrigin: rawOrigin, loginHint: rawHint, deviceId: rawDeviceId } = req.query as Record<string, string | undefined>;
  const appOrigin = resolveAppOrigin(rawOrigin);
  const loginHint = rawHint && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawHint) ? rawHint : undefined;
  const deviceId = typeof rawDeviceId === 'string' && rawDeviceId.trim().length > 0 ? rawDeviceId.trim().slice(0, 256) : undefined;
  const state = googleService.generateSignedState({ action: 'login', appOrigin, deviceId, loginHint });
  return reply.redirect(googleService.getAuthUrl(state, loginHint));
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
  const appOrigin = statePayload.appOrigin as string | undefined;

  if (action === 'connect') {
    // Account linking flow
    const userId = statePayload.sub as string;
    const result = await googleService.handleCallback(code, userId);
    if ((result as Record<string, unknown>).error) {
      return reply.code((result as Record<string, number>).status).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error, appOrigin));
    }
    return reply.type('text/html').send(callbackHtml(true, null, appOrigin));
  }

  if (action === 'login') {
    // Sign-in flow
    const result = await googleService.handleLoginCallback(code);
    if ((result as Record<string, unknown>).error) {
      return reply.code((result as Record<string, number>).status).type('text/html').send(callbackHtml(false, (result as Record<string, string>).error, appOrigin));
    }

    // If the flow was initiated with a loginHint, verify the authenticated account
    // matches so that selecting a different account in the picker is rejected.
    const loginHint = statePayload.loginHint as string | undefined;
    const authenticatedEmail = (result as Record<string, string>).email;
    if (loginHint && authenticatedEmail !== loginHint) {
      return reply.code(400).type('text/html').send(callbackHtml(false, 'wrong_account', appOrigin));
    }

    // Get tokens and create an OTT instead of setting cookies directly.
    // The client will exchange the OTT via POST /auth/exchange-ott, which goes
    // through the Vercel proxy — ensuring cookies are scoped to the frontend domain.
    const userId = (result as Record<string, unknown>).userId as string;
    const deviceId = (statePayload.deviceId as string | undefined) || 'unknown';
    const userAgent = (req.headers['user-agent'] as string) || '';
    const platformVersion = (req.headers['sec-ch-ua-platform-version'] as string) || undefined;

    const tokens = await authService.loginByUserId(userId, jwtTools, req.ip, deviceId, userAgent, platformVersion);

    const tokensResult = tokens as Record<string, unknown> | null;
    if (!tokensResult || tokensResult.error) {
      return reply.code(500).type('text/html').send(callbackHtml(false, (tokensResult?.error as string) || 'Failed to create session', appOrigin));
    }

    const ott = createOtt({
      accessToken: tokensResult.accessToken as string,
      refreshToken: tokensResult.refreshToken as string,
    });

    return reply.type('text/html').send(callbackHtml(true, null, appOrigin, ott));
  }

  return reply.code(400).type('text/html').send(callbackHtml(false, 'Invalid action', appOrigin));
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
