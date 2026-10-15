import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const saved = vi.hoisted(() => ({ value: undefined as boolean | undefined, lookups: 0 }));
vi.mock('../settings/settings.model.js', () => ({
  default: {
    findOne: () => ({
      select: () => ({
        lean: async () => {
          saved.lookups += 1;
          return saved.value === undefined ? null : { export: { includeFeaturedInTitle: saved.value } };
        },
      }),
    }),
  },
}));
vi.mock('../../db/job-log.model.js', () => ({ default: {} }));

import lyricsRoutes from './lyrics.routes.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  // Stand-in for the auth plugin: a header names the signed-in user.
  app.decorate('optionalAuth', async (req: { headers: Record<string, unknown>; userId?: string }) => {
    if (typeof req.headers['x-test-user'] === 'string') req.userId = req.headers['x-test-user'];
  });
  await app.register(lyricsRoutes, { prefix: '/lyrics' });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => { saved.value = undefined; saved.lookups = 0; });

const lines = [{ text: 'hi', timestamp: 1, id: 'x' }];
const artists = [
  { name: 'Drake', role: 'primary' },
  { name: 'Rihanna', role: 'featured' },
  { name: 'Kanye', role: 'featured' },
];

async function compile(body: Record<string, unknown>, user?: string) {
  const res = await app.inject({
    method: 'POST', url: '/lyrics/compile/lrc',
    headers: user ? { 'x-test-user': user } : {},
    payload: { lines, metadata: { ti: 'Song', artists }, ...body },
  });
  return { status: res.statusCode, header: (res.json().output as string)?.split('\n')[0], body: res.json() };
}

describe('POST /lyrics/compile/lrc: includeFeaturedInTitle', () => {
  it('body true wins and adds the featured artists', async () => {
    expect((await compile({ includeFeaturedInTitle: true })).header).toBe('[ti:Song (feat. Rihanna & Kanye)]');
  });

  it('body false wins over a saved true', async () => {
    saved.value = true;
    expect((await compile({ includeFeaturedInTitle: false }, 'u1')).header).toBe('[ti:Song]');
    expect(saved.lookups).toBe(0);
  });

  it('an omitted flag falls back to the signed-in user’s saved setting', async () => {
    saved.value = true;
    expect((await compile({}, 'u1')).header).toBe('[ti:Song (feat. Rihanna & Kanye)]');
  });

  it('an omitted flag with no saved setting stays plain', async () => {
    expect((await compile({}, 'u1')).header).toBe('[ti:Song]');
  });

  it('an omitted flag for an anonymous request stays plain, even if a setting exists', async () => {
    saved.value = true;
    expect((await compile({})).header).toBe('[ti:Song]');
    expect(saved.lookups).toBe(0);
  });

  it('does not look the setting up when there are no featured credits', async () => {
    saved.value = true;
    const r = await compile({ metadata: { ti: 'Song', artists: [artists[0]] } }, 'u1');
    expect(r.header).toBe('[ti:Song]');
    expect(saved.lookups).toBe(0);
  });

  it('still rejects invalid credits', async () => {
    const r = await compile({ metadata: { ti: 'Song', artists: [{ name: 'A', role: 'featured' }] } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('artist_primary_required');
  });
});
