import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const genius = vi.hoisted(() => ({ searchGeniusArtists: vi.fn(), copyGeniusArtistPhoto: vi.fn() }));
const admin = vi.hoisted(() => ({ assertManager: vi.fn() }));
vi.mock('./catalog.genius.service.js', () => genius);
vi.mock('./catalog.admin.service.js', () => admin);

import catalogRoutes from './catalog.routes.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { global: false });
  // Stub auth: the user comes from a test header, 401 when absent.
  app.decorate('requireAuth', async (req: any, reply: any) => {
    const id = req.headers['x-user'];
    if (!id) return reply.code(401).send({ error: 'Unauthorized' });
    req.userId = id;
  });
  await app.register(catalogRoutes, { prefix: '/catalog' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  genius.searchGeniusArtists.mockReset().mockResolvedValue([]);
  genius.copyGeniusArtistPhoto.mockReset().mockResolvedValue({ imageUrl: 'https://x/y.jpg', sourceUrl: 'https://genius.com/artists/A' });
  admin.assertManager.mockReset().mockResolvedValue(null);
});

const get = (qs: string, user = 'u1') =>
  app.inject({ method: 'GET', url: `/catalog/genius/artists${qs}`, headers: { 'x-user': user } });
const post = (payload: unknown, user = 'u1') =>
  app.inject({ method: 'POST', url: '/catalog/genius/photo', payload: payload as object, headers: { 'x-user': user } });

describe('catalog genius routes', () => {
  it('401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/catalog/genius/artists?q=a' });
    expect(res.statusCode).toBe(401);
  });

  it('400 for missing or over-long q', async () => {
    expect((await get('')).statusCode).toBe(400);
    expect((await get('?q=')).statusCode).toBe(400);
    expect((await get(`?q=${'a'.repeat(201)}`)).statusCode).toBe(400);
    expect((await get(`?q=${'a'.repeat(200)}`)).statusCode).toBe(200);
  });

  it('400 when geniusId is not an integer >= 1 or extra fields are sent', async () => {
    for (const body of [{}, { geniusId: 0 }, { geniusId: 1.5 }, { geniusId: 1, imageUrl: 'https://evil/x.jpg' }]) {
      expect((await post(body)).statusCode).toBe(400);
    }
    expect(genius.copyGeniusArtistPhoto).not.toHaveBeenCalled();
  });

  it('200 with artists / photo for a manager', async () => {
    genius.searchGeniusArtists.mockResolvedValue([{ geniusId: 1, name: 'A', imageUrl: 'i', url: 'u' }]);
    const a = await get('?q=a');
    expect(a.json()).toEqual({ artists: [{ geniusId: 1, name: 'A', imageUrl: 'i', url: 'u' }] });
    const p = await post({ geniusId: 7 });
    expect(p.statusCode).toBe(200);
    expect(genius.copyGeniusArtistPhoto).toHaveBeenCalledWith('u1', 7);
  });

  it('403 without catalog.manage (search checks before calling Genius)', async () => {
    admin.assertManager.mockResolvedValue({ status: 403, code: 'CATALOG_FORBIDDEN', error: 'You cannot manage the catalog' });
    const res = await get('?q=a');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'You cannot manage the catalog', code: 'catalog_forbidden' });
    expect(genius.searchGeniusArtists).not.toHaveBeenCalled();
  });

  it('maps service errors to { error, code }', async () => {
    genius.copyGeniusArtistPhoto.mockResolvedValue({ status: 422, code: 'CATALOG_GENIUS_IMAGE_REJECTED', error: 'That Genius photo cannot be used' });
    const res = await post({ geniusId: 3 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'That Genius photo cannot be used', code: 'catalog_genius_image_rejected' });
  });

  it('503 when search is unconfigured; 502 opaque when it throws', async () => {
    genius.searchGeniusArtists.mockResolvedValue(null);
    const a = await get('?q=a');
    expect(a.statusCode).toBe(503);
    expect(a.json().code).toBe('catalog_genius_unavailable');
    genius.searchGeniusArtists.mockRejectedValue(new Error('secret-token genius_upstream'));
    const b = await get('?q=a');
    expect(b.statusCode).toBe(502);
    expect(b.json().code).toBe('catalog_genius_upstream');
    expect(b.body).not.toContain('secret-token');
    genius.copyGeniusArtistPhoto.mockRejectedValue(new Error('secret-token'));
    const c = await post({ geniusId: 3 });
    expect(c.statusCode).toBe(502);
    expect(c.body).not.toContain('secret-token');
  });

  it('31st call within the hour → 429, a second user unaffected', async () => {
    for (let i = 0; i < 30; i++) expect((await get('?q=a', 'limited')).statusCode).toBe(200);
    expect((await get('?q=a', 'limited')).statusCode).toBe(429);
    expect((await get('?q=a', 'other')).statusCode).toBe(200);
    // the photo route has its own bucket
    expect((await post({ geniusId: 1 }, 'limited')).statusCode).toBe(200);
  });
});
