import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { isReservedAccountName } from './auth.validation.js';
import { registerSchema, loginSchema, appealSchema } from './auth.schema.js';
import { handleFastifyError } from '../../shared/error-handler.js';

describe('reserved names', () => {
  it('covers every top-level client route segment', () => {
    for (const n of [
      'admin', 'auth', 'explore', 'feed', 'guide', 'home', 'leaderboard', 'library', 'login',
      'notifications', 'profile', 'project', 'projects', 'register', 'reset-password',
      'change-password', 'search', 'settings', 'share', 'u', 'uploads', 'verify-email', 'og', 'api', 'session', 'join',
    ]) {
      expect(isReservedAccountName(n), n).toBe(true);
    }
    expect(isReservedAccountName('Explore')).toBe(true);
    expect(isReservedAccountName('32blunts')).toBe(false);
  });
});

/**
 * The account-name invariant. Every account must have one: `/:accountName` is
 * the profile URL and every project URL is scoped under it, so an email-only
 * account would be unaddressable and `projectPath()` throws for its projects.
 * Registration used to accept `anyOf: [accountName, email]` — these guard
 * against that coming back, and against login losing its email identifier.
 */
async function app(): Promise<FastifyInstance> {
  const f = Fastify();
  f.post('/register', { schema: registerSchema }, async () => ({ ok: true }));
  f.post('/login', { schema: loginSchema }, async () => ({ ok: true }));
  await f.ready();
  return f;
}

const headers = { 'x-device-id': 'dev-1' };

describe('registration requires an account name', () => {
  it('rejects an email-only registration and accepts one with a name', async () => {
    const f = await app();
    try {
      const noName = await f.inject({ method: 'POST', url: '/register', headers, payload: { email: 'a@b.test', password: 'hunter2hunter2' } });
      expect(noName.statusCode).toBe(400);
      expect(noName.json().message).toMatch(/accountName/);

      const named = await f.inject({ method: 'POST', url: '/register', headers, payload: { accountName: 'alice', email: 'a@b.test', password: 'hunter2hunter2' } });
      expect(named.statusCode).toBe(200);

      // An account name alone is still enough — email stays optional.
      const nameOnly = await f.inject({ method: 'POST', url: '/register', headers, payload: { accountName: 'alice', password: 'hunter2hunter2' } });
      expect(nameOnly.statusCode).toBe(200);
    } finally {
      await f.close();
    }
  });

  it('still rejects a malformed account name', async () => {
    const f = await app();
    try {
      for (const accountName of ['ab', 'Alice', 'has space', 'a'.repeat(31)]) {
        const r = await f.inject({ method: 'POST', url: '/register', headers, payload: { accountName, password: 'hunter2hunter2' } });
        expect(r.statusCode, accountName).toBe(400);
      }
    } finally {
      await f.close();
    }
  });
});

describe('login accepts either identifier', () => {
  it('takes an account name or an email in the same field', async () => {
    const f = await app();
    try {
      for (const identifier of ['alice', 'a@b.test']) {
        const r = await f.inject({ method: 'POST', url: '/login', headers, payload: { identifier, password: 'x' } });
        expect(r.statusCode, identifier).toBe(200);
      }
      const missing = await f.inject({ method: 'POST', url: '/login', headers, payload: { password: 'x' } });
      expect(missing.statusCode).toBe(400);
    } finally {
      await f.close();
    }
  });
});

describe('validation errors through the shared handler', () => {
  async function handled(): Promise<FastifyInstance> {
    const f = Fastify();
    f.setErrorHandler(handleFastifyError);
    f.post('/register', { schema: registerSchema }, async () => ({ ok: true }));
    f.post('/appeal', { schema: appealSchema }, async () => ({ ok: true }));
    await f.ready();
    return f;
  }

  it('names a missing header as a header', async () => {
    const f = await handled();
    try {
      const res = await f.inject({ method: 'POST', url: '/register', payload: { accountName: 'alice', password: 'hunter2hunter2' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Missing required header: x-device-id' });
    } finally { await f.close(); }
  });

  it('reports a missing body field as validation_error with the field, not as a header', async () => {
    const f = await handled();
    try {
      const res = await f.inject({ method: 'POST', url: '/appeal', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'validation_error', field: 'appealText' });
    } finally { await f.close(); }
  });

  it('bounds the appeal to the stored 1000 characters', async () => {
    const f = await handled();
    try {
      const res = await f.inject({ method: 'POST', url: '/appeal', payload: { appealText: 'x'.repeat(1001) } });
      expect(res.statusCode).toBe(400);
    } finally { await f.close(); }
  });
});
