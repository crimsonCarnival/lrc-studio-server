import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

const svc = vi.hoisted(() => ({ searchTracks: vi.fn(), lookupTrack: vi.fn() }));
vi.mock('./song-metadata.service.js', () => svc);

import songMetadataRoutes from './song-metadata.routes.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(songMetadataRoutes, { prefix: '/song-metadata' });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  svc.searchTracks.mockReset().mockResolvedValue({ results: [] });
  svc.lookupTrack.mockReset().mockResolvedValue({ name: 'castles' });
});

const get = (url: string) => app.inject({ method: 'GET', url: `/song-metadata${url}` });

describe('GET /song-metadata/search', () => {
  it('passes one featured artist as a list', async () => {
    const res = await get('/search?songName=castles&artistName=Lil%20Peep&featured=Lil%20Tracy');
    expect(res.statusCode).toBe(200);
    expect(svc.searchTracks).toHaveBeenCalledWith({ songName: 'castles', artistName: 'Lil Peep', featuredArtists: ['Lil Tracy'] });
  });

  it('passes repeated featured artists', async () => {
    await get('/search?songName=x&featured=A&featured=B');
    expect(svc.searchTracks).toHaveBeenCalledWith({ songName: 'x', artistName: undefined, featuredArtists: ['A', 'B'] });
  });

  it('requires a song name', async () => {
    expect((await get('/search?artistName=x')).statusCode).toBe(400);
  });

  it('forwards a provider outage', async () => {
    svc.searchTracks.mockResolvedValue({ error: 'Track metadata search failed', status: 502 });
    expect((await get('/search?songName=x')).statusCode).toBe(502);
  });
});

describe('GET /song-metadata/lookup', () => {
  it('404s when nothing is by the requested artist', async () => {
    svc.lookupTrack.mockResolvedValue({ error: 'No matching track found', status: 404 });
    expect((await get('/lookup?songName=castles&artistName=Lil%20Peep')).statusCode).toBe(404);
  });
});
