import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import Fastify, { type FastifyInstance } from 'fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.CLIENT_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';
process.env.OG_API_ORIGIN ||= 'https://api.lrcstudio.app';

import User from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import ogRoutes from './og.routes.js';

/** A real crawler UA — the whole point of this surface. */
const FACEBOOK_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

let mongo: MongoMemoryServer;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = Fastify({ trustProxy: true });
  await app.register(ogRoutes, { prefix: '/og' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Project.deleteMany({}), Lyrics.deleteMany({})]);
});

async function seedPublished() {
  const owner = await User.collection.insertOne({
    accountName: 'crawlerowner', displayName: 'Crawler Owner', email: 'c@x.test',
    passwordHash: 'x', isDeleted: false, ban: { active: false },
    shadowBan: { feed: false, search: false },
  });
  await Project.collection.insertOne({
    publicId: 'pubsong001', userId: owner.insertedId, public: true, readOnly: true,
    metadata: { songName: 'Midnight City', songArtist: 'M83' },
    coverImage: 'https://res.cloudinary.com/testcloud/image/upload/v1/cover.jpg',
  });
  await Lyrics.collection.insertOne({
    publicId: 'pubsong001',
    sections: [{ lines: [{ text: 'The stars align above the city lights' }] }],
  });
  await Project.collection.insertOne({
    publicId: 'prvsong001', userId: owner.insertedId, public: false, readOnly: true,
    metadata: { songName: 'Secret Song', songArtist: 'Hidden Artist' },
  });
}

const asCrawler = (url: string) =>
  app.inject({ method: 'GET', url, headers: { 'user-agent': FACEBOOK_UA } });

describe('GET /og/meta as a crawler', () => {
  it('serves a published song with its real metadata', async () => {
    await seedPublished();
    const res = await asCrawler('/og/meta?path=%2Fproject%2Fpubsong001');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toContain('max-age');

    const body = res.json();
    expect(body.type).toBe('music.song');
    expect(body.title).toContain('Midnight City');
    expect(body.music.musician).toBe('M83');
    expect(body.robots).toBe('index,follow');
    expect(body.image.width).toBe(1200);
    expect(body.image.height).toBe(630);
    expect(body.image.url).toContain('/og/image/project/pubsong001.png');
  });

  it('gives an unpublished song the same bytes as a nonexistent one', async () => {
    await seedPublished();
    const hidden = await asCrawler('/og/meta?path=%2Fproject%2Fprvsong001');
    const missing = await asCrawler('/og/meta?path=%2Fproject%2Fnotathing');

    expect(hidden.statusCode).toBe(200);
    expect(hidden.body).toBe(missing.body);
    expect(hidden.json().robots).toBe('noindex,nofollow');
    expect(hidden.body).not.toContain('Secret Song');
    expect(hidden.body).not.toContain('Hidden Artist');
  });

  it('answers 200 for junk input instead of 400, so a crawler never caches a failure', async () => {
    for (const q of [
      '',
      '?path=',
      '?path=not-a-path',
      '?path=%2F..%2F..%2Fetc%2Fpasswd',
      '?path=' + encodeURIComponent('/project/' + 'x'.repeat(600)),
      '?path=%2Fproject%2Fabc&hl=zz',
      '?hl=es',
    ]) {
      const res = await asCrawler(`/og/meta${q}`);
      expect(res.statusCode, q).toBe(200);
      const body = res.json();
      expect(body.title.length, q).toBeGreaterThan(0);
      expect(body.image.url, q).toMatch(/^https:\/\//);
    }
  });

  it('honours ?hl= for the locale', async () => {
    const en = (await asCrawler('/og/meta?path=%2F&hl=en')).json();
    const es = (await asCrawler('/og/meta?path=%2F&hl=es')).json();
    expect(en.locale).toBe('en_US');
    expect(es.locale).toBe('es_CO');
    expect(en.localeAlternate).toEqual(['es_CO']);
    expect(es.title).not.toBe(en.title);
  });

  it('does not let a forged host reach the og:image URL', async () => {
    await seedPublished();
    const res = await app.inject({
      method: 'GET',
      url: '/og/meta?path=%2Fproject%2Fpubsong001',
      headers: { 'user-agent': FACEBOOK_UA, 'x-forwarded-host': 'evil.example.com' },
    });
    expect(res.body).not.toContain('evil.example.com');
    expect(res.json().image.url).toContain('api.lrcstudio.app');
  });
});

describe('GET /og/image/:type/:id.png', () => {
  it('redirects a published cover to a 1200x630 Cloudinary derivative', async () => {
    await seedPublished();
    const res = await asCrawler('/og/image/project/pubsong001.png');
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('res.cloudinary.com');
    expect(location).toContain('w_1200');
    expect(location).toContain('h_630');
    expect(res.headers['cache-control']).toContain('max-age');
  });

  it('sends private, missing and malformed ids to the identical brand card', async () => {
    await seedPublished();
    const targets = [
      '/og/image/project/prvsong001.png',
      '/og/image/project/notathing.png',
      '/og/image/project/has%20spaces.png',
      '/og/image/bogus/whatever.png',
      '/og/image/list/not-an-objectid.png',
    ];
    const locations = new Set<string>();
    for (const url of targets) {
      const res = await asCrawler(url);
      expect(res.statusCode, url).toBe(302);
      locations.add(res.headers.location as string);
    }
    expect(locations.size).toBe(1);
    expect([...locations][0]).toContain('og-default.png');
  });
});

describe('GET /og/project/:publicId (legacy crawler page)', () => {
  it('returns a locked-down HTML page for a published project', async () => {
    await seedPublished();
    const res = await asCrawler('/og/project/pubsong001');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(res.body).toContain('og:title');
    expect(res.body).toContain('Midnight City');
  });

  it('404s an unpublished project with a noindex branded body, same as a missing one', async () => {
    await seedPublished();
    const hidden = await asCrawler('/og/project/prvsong001');
    const missing = await asCrawler('/og/project/notathing');

    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.body).not.toContain('Secret Song');
    expect(hidden.body).toContain('noindex');
    expect(hidden.body.length).toBe(missing.body.length);
  });
});
