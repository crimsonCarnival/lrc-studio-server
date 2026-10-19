import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.CLIENT_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';

const state = vi.hoisted(() => ({ hidden: false }));
vi.mock('./og.meta.service.js', async (orig) => {
  const real = await orig<typeof import('./og.meta.service.js')>();
  return {
    ...real,
    resolveProjectMeta: async () => state.hidden
      ? real.buildHiddenMeta('en')
      : real.buildProjectMeta(
        { publicId: 'E46boTClMr', songName: 'Creep', songArtist: 'Radiohead', ownerAccountName: '32blunts', lyricLines: [] },
        'en',
        'https://api.lrcstudio.app',
      ),
  };
});

import ogRoutes from './og.routes.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ trustProxy: true });
  await app.register(ogRoutes, { prefix: '/og' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'user-agent': 'facebookexternalhit/1.1' } });
const redirectOf = (body: string) => /<meta http-equiv="refresh" content="0; url=([^"]+)">/.exec(body)?.[1];

const CANONICAL = 'https://www.lrcstudio.app/32blunts/projects/radiohead-creep-E46boTClMr';

describe('GET /og/project/:publicId redirect target', () => {
  it('sends people to the canonical slug URL — the only project URL there is', async () => {
    state.hidden = false;
    const res = await get('/og/project/E46boTClMr');
    expect(res.statusCode).toBe(200);
    expect(redirectOf(res.body)).toBe(CANONICAL);
    // The old /project/:id route is gone from the client, so redirecting there
    // would land a visitor on the 404 page.
    expect(res.body).not.toMatch(/refresh[^>]*\/project\/E46boTClMr/);
  });

  it('sends crawlers to that same URL as canonical / og:url', async () => {
    state.hidden = false;
    const { body } = await get('/og/project/E46boTClMr');
    expect(body).toContain(`<link rel="canonical" href="${CANONICAL}">`);
    expect(body).toContain(`<meta property="og:url" content="${CANONICAL}">`);
  });

  it('carries a valid ?s= and ?list= through, and drops junk', async () => {
    state.hidden = false;
    const ok = await get('/og/project/E46boTClMr?s=42.5&list=abc_1');
    expect(redirectOf(ok.body)).toBe(`${CANONICAL}?s=42.5&amp;list=abc_1`);
    const junk = await get('/og/project/E46boTClMr?s=%3Cx%3E&list=a%20b');
    expect(redirectOf(junk.body)).toBe(CANONICAL);
  });

  it('a hidden project redirects home and leaks nothing', async () => {
    state.hidden = true;
    const res = await get('/og/project/E46boTClMr');
    expect(res.statusCode).toBe(404);
    expect(redirectOf(res.body)).toBe('https://www.lrcstudio.app/');
    expect(res.body).not.toMatch(/Creep|Radiohead|32blunts/);
  });
});
