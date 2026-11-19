import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const genius = vi.hoisted(() => ({ searchGeniusArtists: vi.fn(), copyGeniusArtistPhoto: vi.fn(), searchGeniusAlbums: vi.fn(), copyGeniusAlbumCover: vi.fn() }));
const covers = vi.hoisted(() => ({ listProjectCoverProposals: vi.fn(), copyProjectCover: vi.fn() }));
vi.mock('./catalog.genius.service.js', () => genius);
vi.mock('./catalog.album-cover.service.js', () => covers);

import catalogRoutes from './catalog.routes.js';

let app: FastifyInstance;
const permsAsked: string[] = [];

beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { global: false });
  // Stub auth: the user comes from a test header, 401 when absent; set before the limiter's key generator runs.
  // Stub requirePermission: users named 'nomanage' lack the permission (403); records the permission asked for.
  app.decorate('requirePermission', (perm: string) => {
    permsAsked.push(perm);
    return async (req: any, reply: any) => {
      const id = req.headers['x-user'];
      if (!id) return reply.code(401).send({ error: 'Authentication required' });
      req.userId = id;
      if (id === 'nomanage') return reply.code(403).send({ error: 'Insufficient permissions' });
    };
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
  genius.searchGeniusAlbums.mockReset().mockResolvedValue([]);
  genius.copyGeniusAlbumCover.mockReset().mockResolvedValue({ imageUrl: 'https://x/z.jpg', sourceUrl: 'https://genius.com/albums/A/B' });
  covers.listProjectCoverProposals.mockReset().mockResolvedValue([]);
  covers.copyProjectCover.mockReset().mockResolvedValue({ imageUrl: 'https://x/p.jpg' });
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

  it('403 at the route for a signed-in user without catalog.manage, before any service call', async () => {
    expect(permsAsked).toEqual(Array(6).fill('catalog.manage'));
    const a = await get('?q=a', 'nomanage');
    expect(a.statusCode).toBe(403);
    const p = await post({ geniusId: 1 }, 'nomanage');
    expect(p.statusCode).toBe(403);
    expect(genius.searchGeniusArtists).not.toHaveBeenCalled();
    expect(genius.copyGeniusArtistPhoto).not.toHaveBeenCalled();
  });

  it('service-level denial maps to { error, code } 403', async () => {
    genius.searchGeniusArtists.mockResolvedValue({ status: 403, code: 'CATALOG_FORBIDDEN', error: 'You cannot manage the catalog' });
    const res = await get('?q=a');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'You cannot manage the catalog', code: 'catalog_forbidden' });
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

describe('catalog album cover routes', () => {
  const ARTIST = 'a'.repeat(24);
  const albums = (qs: string, user = 'u1') => app.inject({ method: 'GET', url: `/catalog/genius/albums${qs}`, headers: { 'x-user': user } });
  const albumCover = (payload: unknown, user = 'u1') => app.inject({ method: 'POST', url: '/catalog/genius/album-cover', payload: payload as object, headers: { 'x-user': user } });
  const proj = (qs: string, user = 'u1') => app.inject({ method: 'GET', url: `/catalog/album-covers/projects${qs}`, headers: { 'x-user': user } });
  const projCopy = (payload: unknown, user = 'u1') => app.inject({ method: 'POST', url: '/catalog/album-covers/project', payload: payload as object, headers: { 'x-user': user } });

  it('403 without catalog.manage, before any service call', async () => {
    expect((await albums('?q=a', 'nomanage')).statusCode).toBe(403);
    expect((await albumCover({ geniusId: 1 }, 'nomanage')).statusCode).toBe(403);
    expect((await proj(`?artistId=${ARTIST}&title=t`, 'nomanage')).statusCode).toBe(403);
    expect((await projCopy({ artistId: ARTIST, title: 't', publicId: 'p' }, 'nomanage')).statusCode).toBe(403);
    expect(genius.searchGeniusAlbums).not.toHaveBeenCalled();
    expect(genius.copyGeniusAlbumCover).not.toHaveBeenCalled();
    expect(covers.listProjectCoverProposals).not.toHaveBeenCalled();
    expect(covers.copyProjectCover).not.toHaveBeenCalled();
  });

  it('validates input; the project copy takes ids only, never a URL', async () => {
    expect((await albums('')).statusCode).toBe(400);
    expect((await albumCover({ geniusId: 0 })).statusCode).toBe(400);
    expect((await proj('?title=t')).statusCode).toBe(400);
    expect((await projCopy({ artistId: ARTIST, title: 't', publicId: 'p', imageUrl: 'https://evil/x.png' })).statusCode).toBe(400);
    expect((await projCopy({ artistId: ARTIST, title: 't' })).statusCode).toBe(400);
    expect(covers.copyProjectCover).not.toHaveBeenCalled();
  });

  it('200 for a manager, passing the user and ids to the services', async () => {
    genius.searchGeniusAlbums.mockResolvedValue([{ geniusId: 1, name: 'A', artistName: 'B', imageUrl: 'i', url: 'u' }]);
    expect((await albums('?q=a')).json()).toEqual({ albums: [{ geniusId: 1, name: 'A', artistName: 'B', imageUrl: 'i', url: 'u' }] });
    expect((await albumCover({ geniusId: 7 })).statusCode).toBe(200);
    expect(genius.copyGeniusAlbumCover).toHaveBeenCalledWith('u1', 7);
    covers.listProjectCoverProposals.mockResolvedValue([{ publicId: 'p1', title: 'T', coverUrl: 'c' }]);
    expect((await proj(`?artistId=${ARTIST}&title=Alb`)).json()).toEqual({ covers: [{ publicId: 'p1', title: 'T', coverUrl: 'c' }] });
    expect(covers.listProjectCoverProposals).toHaveBeenCalledWith('u1', ARTIST, 'Alb');
    expect((await projCopy({ artistId: ARTIST, title: 'Alb', publicId: 'p1' })).json()).toEqual({ imageUrl: 'https://x/p.jpg' });
    expect(covers.copyProjectCover).toHaveBeenCalledWith('u1', ARTIST, 'Alb', 'p1');
  });

  it('maps service errors and keeps upstream failures opaque', async () => {
    covers.copyProjectCover.mockResolvedValue({ status: 404, code: 'CATALOG_COVER_PROPOSAL_NOT_FOUND', error: 'That cover is no longer available' });
    const res = await projCopy({ artistId: ARTIST, title: 't', publicId: 'gone' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('catalog_cover_proposal_not_found');
    genius.searchGeniusAlbums.mockRejectedValue(new Error('secret-token'));
    const up = await albums('?q=a');
    expect(up.statusCode).toBe(502);
    expect(up.body).not.toContain('secret-token');
    genius.searchGeniusAlbums.mockResolvedValue(null);
    expect((await albums('?q=a')).statusCode).toBe(503);
  });
});