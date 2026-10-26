import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../config/env.js', () => ({ getEnv: () => ({ APP_URL: 'https://www.example.test' }) }));

import rootRoutes from './root.routes.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });

async function build() {
  const app = Fastify();
  await app.register(rootRoutes);
  apps.push(app);
  return app;
}

describe('API host root', () => {
  it('redirects to the configured app URL with a temporary redirect', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://www.example.test');
  });

  it('ignores request input when choosing the destination', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/?next=https://evil.test', headers: { host: 'evil.test', 'x-forwarded-host': 'evil.test' } });
    expect(res.headers.location).toBe('https://www.example.test');
  });

  it('leaves every other path with its JSON 404', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/graphql-typo' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
