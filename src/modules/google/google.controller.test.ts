import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../config/env.js', () => ({
  getEnv: () => ({
    APP_URLS: ['https://www.lrcstudio.app'],
    APP_URL: 'https://www.lrcstudio.app',
    CORS_ORIGIN: 'https://www.lrcstudio.app,https://m.lrcstudio.app,https://admin.lrcstudio.app',
  }),
}));
vi.mock('../auth/auth.service.js', () => ({ loginByUserId: vi.fn() }));
vi.mock('../../plugins/auth.js', () => ({ jwtTools: {} }));

import { googleRoutes } from './google.routes.js';
import * as googleService from './google.service.js';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://api.lrcstudio.app/google/auth/callback';
  process.env.JWT_SECRET = 'test-secret';
  app = Fastify();
  app.decorate('requireAuth', async () => {});
  await app.register(googleRoutes, { prefix: '/google' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('GET /google/login/url', () => {
  it.each(['https://www.lrcstudio.app', 'https://m.lrcstudio.app', 'https://admin.lrcstudio.app'])(
    'carries %s through the signed state',
    async (origin) => {
      const res = await app.inject({ url: `/google/login/url?appOrigin=${encodeURIComponent(origin)}` });
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.searchParams.get('redirect_uri')).toBe(process.env.GOOGLE_REDIRECT_URI);
      const state = googleService.verifySignedState(loc.searchParams.get('state')!);
      expect(state?.appOrigin).toBe(origin);
    },
  );

  it('rejects an origin outside the allowlist', async () => {
    const res = await app.inject({ url: '/google/login/url?appOrigin=https%3A%2F%2Fevil.example' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  it('is 503 when the redirect URI is not configured', async () => {
    const saved = process.env.GOOGLE_REDIRECT_URI;
    delete process.env.GOOGLE_REDIRECT_URI;
    const res = await app.inject({ url: '/google/login/url' });
    process.env.GOOGLE_REDIRECT_URI = saved;
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /google/auth/callback', () => {
  it('escapes the Google error and targets the origin from state', async () => {
    const state = googleService.generateSignedState({ action: 'login', appOrigin: 'https://m.lrcstudio.app' });
    const res = await app.inject({
      url: `/google/auth/callback?state=${state}&error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`,
    });
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img');
    expect(res.body).toContain('"https://m.lrcstudio.app"');
  });
});
