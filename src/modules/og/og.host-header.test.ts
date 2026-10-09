import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import Fastify, { type FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

/**
 * Guards the host-header fix specifically.
 *
 * The companion og.routes.test.ts runs with OG_API_ORIGIN set, so it never
 * reaches the header-derived branch — it would pass even with the bug present.
 * This file deliberately leaves OG_API_ORIGIN UNSET and pretends to be
 * production, which is exactly the misconfiguration that made the original
 * code trust X-Forwarded-Host.
 *
 * Vitest isolates files in separate workers, so these env values do not leak
 * into the other suites (getEnv() caches on first call).
 */
delete process.env.OG_API_ORIGIN;
process.env.NODE_ENV = 'production';
process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.CLIENT_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';

import User from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import ogRoutes from './og.routes.js';

const FACEBOOK_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const EVIL = 'evil.example.com';

let mongo: MongoMemoryServer;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const owner = await User.collection.insertOne({
    accountName: 'hostowner', displayName: 'Host Owner', email: 'h@x.test',
    passwordHash: 'x', isDeleted: false, ban: { active: false },
    shadowBan: { feed: false, search: false },
  });
  await Project.collection.insertOne({
    publicId: 'hostsong01', userId: owner.insertedId, public: true, readOnly: true,
    metadata: { songName: 'Host Song', songArtist: 'Someone' },
  });

  // trustProxy mirrors the real server (server.ts), which is what makes
  // request.host honour X-Forwarded-Host in the first place.
  app = Fastify({ trustProxy: true });
  await app.register(ogRoutes, { prefix: '/og' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongoose.disconnect();
  await mongo.stop();
});

describe('host header cannot reach og:image in production', () => {
  const forged = (headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/og/meta?path=%2Fproject%2Fhostsong01',
      headers: { 'user-agent': FACEBOOK_UA, ...headers },
    });

  it('ignores X-Forwarded-Host', async () => {
    const res = await forged({ 'x-forwarded-host': EVIL });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(EVIL);
    expect(res.json().image.url).toContain('api.lrcstudio.app');
  });

  it('ignores a forged Host header', async () => {
    const res = await forged({ host: EVIL });
    expect(res.body).not.toContain(EVIL);
  });

  it('ignores X-Forwarded-Proto downgrade attempts', async () => {
    const res = await forged({ 'x-forwarded-proto': 'http', 'x-forwarded-host': EVIL });
    const image = res.json().image;
    expect(image.url.startsWith('https://')).toBe(true);
    expect(image.secureUrl.startsWith('https://')).toBe(true);
    expect(res.body).not.toContain(EVIL);
  });

  it('produces the same card URL regardless of the headers sent', async () => {
    const clean = (await forged({})).json().image.url;
    const dirty = (await forged({ 'x-forwarded-host': EVIL, host: EVIL })).json().image.url;
    expect(dirty).toBe(clean);
  });
});
