import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const service = vi.hoisted(() => ({
  getSongConnections: vi.fn(),
  isGeniusConfigured: vi.fn(),
}));
vi.mock('./song-connections.service.js', () => service);

import geniusRoutes from './genius.routes.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.decorate('optionalAuth', async () => {});
  await app.register(geniusRoutes, { prefix: '/lyrics' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  service.getSongConnections.mockReset();
  service.isGeniusConfigured.mockReset().mockReturnValue(true);
});

const get = (qs: string) => app.inject({ method: 'GET', url: `/lyrics/connections${qs}` });

describe('GET /lyrics/connections', () => {
  it('400 when neither geniusId nor track+artist', async () => {
    expect((await get('')).statusCode).toBe(400);
    expect((await get('?track=Song')).statusCode).toBe(400);
    expect((await get('?artist=Band')).statusCode).toBe(400);
    expect(service.getSongConnections).not.toHaveBeenCalled();
  });

  it('400 when geniusId is not an integer >= 1', async () => {
    expect((await get('?geniusId=0')).statusCode).toBe(400);
    expect((await get('?geniusId=-3')).statusCode).toBe(400);
    expect((await get('?geniusId=1.5')).statusCode).toBe(400);
    expect((await get('?geniusId=abc')).statusCode).toBe(400);
  });

  it('404 no_match when the service returns null', async () => {
    service.getSongConnections.mockResolvedValue(null);
    const res = await get('?track=Song&artist=Band');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No match', code: 'no_match' });
  });

  it('503 when Genius is not configured', async () => {
    service.isGeniusConfigured.mockReturnValue(false);
    const res = await get('?geniusId=5');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Unavailable', code: 'genius_unavailable' });
    expect(service.getSongConnections).not.toHaveBeenCalled();
  });

  it('502 with an opaque body when the service throws', async () => {
    service.getSongConnections.mockRejectedValue(
      new Error('genius_upstream', { cause: new Error('secret-cause-token') }),
    );
    const res = await get('?geniusId=5');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Upstream error', code: 'genius_upstream' });
    expect(res.body).not.toContain('secret-cause-token');
  });

  it('502 opaque body for genius_unauthorized too', async () => {
    service.getSongConnections.mockRejectedValue(new Error('genius_unauthorized'));
    const res = await get('?geniusId=5');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Upstream error', code: 'genius_upstream' });
    expect(res.body).not.toContain('unauthorized');
  });

  it('200 passes the result through, coercing geniusId to a number', async () => {
    const result = { geniusId: 5, url: 'https://genius.com/x', title: 'T', artist: 'A', album: null, releaseDate: null, groups: [] };
    service.getSongConnections.mockResolvedValue(result);
    const res = await get('?geniusId=5');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
    expect(service.getSongConnections).toHaveBeenCalledWith({ geniusId: 5 });

    await get('?track=Song&artist=Band');
    expect(service.getSongConnections).toHaveBeenLastCalledWith({ track: 'Song', artist: 'Band' });
  });
});
