import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';

const svc = vi.hoisted(() => ({
  checkNames: vi.fn(),
  splitTitle: vi.fn(),
  describeSong: vi.fn(),
  romanizeLines: vi.fn(),
  labelSingers: vi.fn(),
  runHeavy: vi.fn(),
  getHeavyUsage: vi.fn(),
}));
vi.mock('./name-check.service.js', () => ({ checkNames: svc.checkNames }));
vi.mock('./title-split.service.js', () => ({ splitTitle: svc.splitTitle }));
vi.mock('./describe.service.js', () => ({ describeSong: svc.describeSong }));
vi.mock('./romanize.service.js', () => ({ romanizeLines: svc.romanizeLines }));
vi.mock('./singers.service.js', () => ({ labelSingers: svc.labelSingers }));
vi.mock('./assist-usage.service.js', () => ({ runHeavy: svc.runHeavy, getHeavyUsage: svc.getHeavyUsage }));

import { AssistError } from './groq-chat.client.js';
import assistRoutes from './assist.routes.js';

const USER_A = '64b000000000000000000001';
const USER_B = '64b000000000000000000002';
const resetsAt = new Date('2026-11-16T00:00:00.000Z');
const usage = { used: 1, cap: 20, remaining: 19, resetsAt };

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(fastifyRateLimit, { global: false });
  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    const u = request.headers['x-test-user'];
    if (!u) return reply.code(401).send({ error: 'Unauthorized' });
    request.userId = u as string;
  });
  await app.register(assistRoutes, { prefix: '/assist' });
  await app.ready();
});
afterAll(async () => { await app.close(); });

beforeEach(() => {
  for (const m of Object.values(svc)) m.mockReset();
  svc.checkNames.mockResolvedValue([]);
  svc.splitTitle.mockResolvedValue({ songName: 'S', artists: [], album: null });
  svc.describeSong.mockResolvedValue({ language: null, genre: null, tags: [] });
  svc.romanizeLines.mockResolvedValue(['a']);
  svc.labelSingers.mockResolvedValue([]);
  svc.getHeavyUsage.mockResolvedValue(usage);
  svc.runHeavy.mockImplementation(async (_u: string, fn: () => Promise<unknown>) => ({ result: await fn(), usage }));
});

let seq = 0;
let userA = USER_A;
beforeEach(() => { userA = `64b${String(++seq).padStart(21, '0')}`; });
const post = (url: string, payload: unknown, user: string | null = userA) =>
  app.inject({ method: 'POST', url: `/assist${url}`, payload: payload as object, headers: user ? { 'x-test-user': user } : {} });

const valid: Record<string, unknown> = {
  '/name-check': { title: 'T', artist: 'A' },
  '/title-split': { title: 'T' },
  '/describe': { lines: ['x'] },
  '/romanize': { lines: ['x'] },
  '/singers': { lines: ['x'], roster: ['a', 'b'] },
};

describe('assist routes', () => {
  it('401 without a user on every route', async () => {
    for (const [url, body] of Object.entries(valid)) expect((await post(url, body, null)).statusCode, url).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/assist/usage' })).statusCode).toBe(401);
  });

  it('400 on 201 lines, on a 501-char line, on an extra property, on a 1-name roster', async () => {
    const lines201 = Array.from({ length: 201 }, () => 'x');
    expect((await post('/romanize', { lines: lines201 })).statusCode).toBe(400);
    expect((await post('/singers', { lines: lines201, roster: ['a', 'b'] })).statusCode).toBe(400);
    expect((await post('/describe', { lines: ['x'.repeat(501)] })).statusCode).toBe(400);
    expect((await post('/title-split', { title: 'T', extra: 1 })).statusCode).toBe(400);
    expect((await post('/singers', { lines: ['x'], roster: ['a'] })).statusCode).toBe(400);
    expect((await post('/name-check', { title: 'T' })).statusCode).toBe(400);
    for (const m of [svc.checkNames, svc.splitTitle, svc.describeSong, svc.romanizeLines, svc.labelSingers, svc.runHeavy]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it('maps AssistError codes to 503 / 502 / 429 and the body is exactly { error } (plus resetsAt for the cap)', async () => {
    svc.splitTitle.mockRejectedValueOnce(new AssistError('assist_unavailable'));
    let res = await post('/title-split', valid['/title-split']);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'assist_unavailable' });

    svc.splitTitle.mockRejectedValueOnce(new AssistError('assist_upstream'));
    res = await post('/title-split', valid['/title-split']);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'assist_upstream' });

    const capped = Object.assign(new AssistError('assist_daily_cap'), { resetsAt });
    svc.runHeavy.mockRejectedValueOnce(capped);
    res = await post('/romanize', valid['/romanize']);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: 'assist_daily_cap', resetsAt: resetsAt.toISOString() });
  });

  it('an unexpected error becomes 502 assist_upstream with no message leak', async () => {
    svc.describeSong.mockRejectedValueOnce(new Error('secret-internal-detail'));
    const res = await post('/describe', valid['/describe']);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'assist_upstream' });
    expect(res.body).not.toContain('secret-internal-detail');
  });

  it("rate limit is per user: user A's 61st name-check is 429, user B still gets 200", async () => {
    for (let i = 0; i < 60; i++) expect((await post('/name-check', valid['/name-check'], userA)).statusCode).toBe(200);
    expect((await post('/name-check', valid['/name-check'], userA)).statusCode).toBe(429);
    expect((await post('/name-check', valid['/name-check'], USER_B)).statusCode).toBe(200);
  });

  it('romanize returns usage from runHeavy', async () => {
    const res = await post('/romanize', { lines: ['x'], language: 'ja' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: ['a'], usage: { ...usage, resetsAt: resetsAt.toISOString() } });
    expect(svc.runHeavy).toHaveBeenCalledWith(userA, expect.any(Function));
    expect(svc.romanizeLines).toHaveBeenCalledWith({ lines: ['x'], language: 'ja' });
  });

  it('singers returns labels + usage; GET /usage returns HeavyUsage', async () => {
    svc.labelSingers.mockResolvedValue([{ lineIndex: 0, singers: ['a'] }]);
    let res = await post('/singers', valid['/singers']);
    expect(res.json().labels).toEqual([{ lineIndex: 0, singers: ['a'] }]);
    res = await app.inject({ method: 'GET', url: '/assist/usage', headers: { 'x-test-user': userA } });
    expect(res.json()).toEqual({ ...usage, resetsAt: resetsAt.toISOString() });
  });
});
