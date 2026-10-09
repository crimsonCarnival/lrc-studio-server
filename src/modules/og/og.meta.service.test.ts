import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import User from '../../db/user.model.js';
import Playlist from '../../db/playlist.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import {
  DESCRIPTION_MAX,
  ROBOTS_INDEX,
  ROBOTS_NOINDEX,
  parseClientPath,
  resolveCardSourceUrl,
  resolveOgMeta,
  truncateAtWord,
  isValidCardId,
} from './og.meta.service.js';

// getEnv() throws outside development when CORS_ORIGIN is unset, and the OG
// services call it lazily to build canonical URLs. Set the minimum env here —
// before any test triggers the first getEnv() — rather than pretending to be a
// development build, which would also switch off the production-only guards
// these tests are meant to exercise.
process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.CLIENT_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Project.deleteMany({}), Lyrics.deleteMany({}), Playlist.deleteMany({}),
  ]);
});

const API = 'https://api.lrcstudio.app';
const meta = (path: string | null | undefined) =>
  resolveOgMeta({ path, locale: 'en', apiOrigin: API });

let seq = 0;
async function mkUser(extra: Record<string, unknown> = {}) {
  seq++;
  const res = await User.collection.insertOne({
    accountName: `owner${seq}`,
    displayName: `Owner ${seq}`,
    email: `owner${seq}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    ban: { active: false },
    shadowBan: { feed: false, search: false },
    ...extra,
  });
  return res.insertedId;
}

async function mkProject(fields: Record<string, unknown>, lyricLines: string[] = []) {
  const publicId = fields.publicId as string;
  await Project.collection.insertOne({
    publicId,
    public: true,
    readOnly: true,
    forksEnabled: true,
    ...fields,
  });
  if (lyricLines.length) {
    await Lyrics.collection.insertOne({
      publicId,
      sections: [{ lines: lyricLines.map((text) => ({ text })) }],
    });
  }
}

// ─── Path parsing ────────────────────────────────────────────────────────────

describe('parseClientPath', () => {
  it('maps the known public routes', () => {
    expect(parseClientPath('/')).toEqual({ kind: 'home' });
    expect(parseClientPath('/explore')).toEqual({ kind: 'explore' });
    expect(parseClientPath('/leaderboard')).toEqual({ kind: 'leaderboard' });
    expect(parseClientPath('/project/abc123XYZ_')).toEqual({ kind: 'project', publicId: 'abc123XYZ_' });
    expect(parseClientPath('/profile/someone')).toEqual({ kind: 'profile', accountName: 'someone' });
    expect(parseClientPath('/profile/someone/lists/0123456789abcdef01234567'))
      .toEqual({ kind: 'list', accountName: 'someone', listId: '0123456789abcdef01234567' });
  });

  it('ignores query and hash', () => {
    expect(parseClientPath('/project/abc?hl=es#x')).toEqual({ kind: 'project', publicId: 'abc' });
  });

  it('accepts a full URL and uses only its path', () => {
    expect(parseClientPath('https://www.lrcstudio.app/leaderboard')).toEqual({ kind: 'leaderboard' });
  });

  it('rejects anything that is not a shape it recognises', () => {
    for (const bad of [
      null, undefined, '', 'project/abc', '/project', '/project/a/b',
      '/profile/someone/lists/not-an-objectid', '/admin', '/../etc/passwd',
    ]) {
      expect(parseClientPath(bad as string).kind).toBe('unknown');
    }
  });

  it('rejects an object-shaped segment rather than letting it reach a filter', () => {
    // A query operator smuggled through the path must never become a filter.
    expect(parseClientPath('/project/%7B%22$ne%22:null%7D').kind).toBe('unknown');
  });

  it('rejects control characters and over-long paths', () => {
    expect(parseClientPath('/project/a\nb').kind).toBe('unknown');
    expect(parseClientPath('/project/' + 'a'.repeat(600)).kind).toBe('unknown');
  });
});

// ─── Description truncation ──────────────────────────────────────────────────

describe('truncateAtWord', () => {
  it('never exceeds the cap', () => {
    const long = 'word '.repeat(200);
    expect(truncateAtWord(long).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it('never splits a word', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec';
    const out = truncateAtWord(text, 40);
    // Everything kept, ignoring a trailing ellipsis, must be a whole word.
    const kept = out.replace(/[….]+$/, '').trim();
    for (const word of kept.split(/\s+/)) {
      expect(text.split(/\s+/)).toContain(word);
    }
  });

  it('leaves a short string alone', () => {
    expect(truncateAtWord('short enough')).toBe('short enough');
  });

  it('handles a single word longer than the cap without looping or returning empty', () => {
    const out = truncateAtWord('x'.repeat(400), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.length).toBeGreaterThan(0);
  });
});

// ─── Static routes ───────────────────────────────────────────────────────────

describe('static routes', () => {
  it('home, explore and leaderboard are indexable websites', async () => {
    for (const path of ['/', '/explore', '/leaderboard']) {
      const m = await meta(path);
      expect(m.type).toBe('website');
      expect(m.robots).toBe(ROBOTS_INDEX);
      expect(m.canonical.startsWith('https://')).toBe(true);
    }
  });

  it('always fills the image block with absolute 1200x630 values', async () => {
    const m = await meta('/');
    expect(m.image.width).toBe(1200);
    expect(m.image.height).toBe(630);
    expect(m.image.url).toMatch(/^https:\/\//);
    expect(m.image.secureUrl).toMatch(/^https:\/\//);
    expect(m.image.type).toBe('image/png');
    expect(m.image.alt.length).toBeGreaterThan(0);
  });
});

// ─── Projects ────────────────────────────────────────────────────────────────

describe('published project', () => {
  it('is a music.song with the artist when one is set', async () => {
    const userId = await mkUser();
    await mkProject(
      { publicId: 'song01', userId, metadata: { songName: 'Midnight City', songArtist: 'M83' } },
      ['The stars align above the city lights', 'Midnight echoes through the empty halls'],
    );

    const m = await meta('/project/song01');
    expect(m.type).toBe('music.song');
    expect(m.music?.musician).toBe('M83');
    expect(m.title).toContain('Midnight City');
    expect(m.title).toContain('M83');
    expect(m.robots).toBe(ROBOTS_INDEX);
    expect(m.description).toContain('The stars align');
    expect(m.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(m.image.url).toContain('/og/image/project/song01.png');
  });

  it('falls back to article when there is no artist', async () => {
    const userId = await mkUser();
    await mkProject({ publicId: 'song02', userId, metadata: { songName: 'Untitled Demo' } }, ['line one']);
    const m = await meta('/project/song02');
    expect(m.type).toBe('article');
    expect(m.music?.musician).toBeUndefined();
  });
});

// ─── Privacy: the load-bearing guarantee ─────────────────────────────────────

describe('privacy', () => {
  const SECRETS = ['Secret Song', 'Hidden Artist', 'nobody should see this lyric', 'owner9000'];

  async function seedPrivate() {
    const userId = await mkUser({ accountName: 'owner9000', displayName: 'Owner 9000' });
    await mkProject(
      {
        publicId: 'privat0001',
        userId,
        public: false,
        title: 'Secret Song',
        metadata: { songName: 'Secret Song', songArtist: 'Hidden Artist' },
      },
      ['nobody should see this lyric'],
    );
  }

  it('an unpublished project is byte-identical to one that never existed', async () => {
    await seedPrivate();
    const hidden = await meta('/project/privat0001');
    const missing = await meta('/project/doesnotexi');
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
  });

  it('leaks no title, artist, lyric or owner for an unpublished project', async () => {
    await seedPrivate();
    const body = JSON.stringify(await meta('/project/privat0001'));
    for (const secret of SECRETS) {
      expect(body.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it('marks hidden resources noindex', async () => {
    await seedPrivate();
    expect((await meta('/project/privat0001')).robots).toBe(ROBOTS_NOINDEX);
    expect((await meta('/project/doesnotexi')).robots).toBe(ROBOTS_NOINDEX);
    expect((await meta('/profile/nosuchuser')).robots).toBe(ROBOTS_NOINDEX);
  });

  it('hides a project whose owner is deleted, banned or shadow-banned', async () => {
    const missing = JSON.stringify(await meta('/project/doesnotexi'));
    const cases = [
      { isDeleted: true },
      { ban: { active: true } },
      { shadowBan: { feed: true, search: true } },
    ];
    let n = 0;
    for (const state of cases) {
      n++;
      const publicId = `hid${n}00000`;
      const userId = await mkUser(state);
      await mkProject({ publicId, userId, metadata: { songName: 'Leaky', songArtist: 'Nope' } }, ['leak']);
      const m = await meta(`/project/${publicId}`);
      expect(m.robots).toBe(ROBOTS_NOINDEX);
      expect(JSON.stringify(m).replace(publicId, 'doesnotexi')).toBe(missing);
    }
  });

  it('hides a private playlist but shows a public one', async () => {
    const userId = await mkUser({ accountName: 'listowner' });
    const open = await Playlist.collection.insertOne({
      userId, name: 'Open List', isPublic: true, projects: [],
    });
    const shut = await Playlist.collection.insertOne({
      userId, name: 'Shut List', isPublic: false, projects: [],
    });

    const shown = await meta(`/profile/listowner/lists/${open.insertedId.toString()}`);
    expect(shown.robots).toBe(ROBOTS_INDEX);
    expect(shown.title).toContain('Open List');

    const hidden = await meta(`/profile/listowner/lists/${shut.insertedId.toString()}`);
    expect(hidden.robots).toBe(ROBOTS_NOINDEX);
    expect(JSON.stringify(hidden)).not.toContain('Shut List');
  });

  it('an unknown route is hidden, not indexed', async () => {
    expect((await meta('/definitely/not/a/route')).robots).toBe(ROBOTS_NOINDEX);
  });

  it('never returns an undefined or empty required field, whatever the input', async () => {
    for (const path of [null, undefined, '', '/', '/project/..', '/\u0000']) {
      const m = await meta(path);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.canonical).toMatch(/^https:\/\//);
      expect(m.image.url).toMatch(/^https:\/\//);
      expect(['index,follow', 'noindex,nofollow']).toContain(m.robots);
    }
  });
});

// ─── Profiles ────────────────────────────────────────────────────────────────

describe('public profile', () => {
  it('is a profile card carrying the username', async () => {
    await mkUser({ accountName: 'visible', displayName: 'Visible Person', bio: 'I sync lyrics.' });
    const m = await meta('/profile/visible');
    expect(m.type).toBe('profile');
    expect(m.profile?.username).toBe('visible');
    expect(m.title).toContain('Visible Person');
    expect(m.robots).toBe(ROBOTS_INDEX);
  });

  it('hides a banned user exactly like a missing one', async () => {
    await mkUser({ accountName: 'banned', displayName: 'Banned', ban: { active: true } });
    const hidden = await meta('/profile/banned');
    const missing = await meta('/profile/ghostuser');
    expect(hidden.robots).toBe(ROBOTS_NOINDEX);
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
  });
});

// ─── Card source resolution ──────────────────────────────────────────────────

describe('resolveCardSourceUrl', () => {
  it('returns the cover of a published project and null for a private one', async () => {
    const userId = await mkUser();
    await mkProject({
      publicId: 'withcover0', userId,
      coverImage: 'https://res.cloudinary.com/dzjid2tos/image/upload/v1/cover.jpg',
    });
    await mkProject({ publicId: 'privcover0', userId, public: false, coverImage: 'https://res.cloudinary.com/dzjid2tos/image/upload/v1/secret.jpg' });

    expect(await resolveCardSourceUrl('project', 'withcover0')).toContain('cover.jpg');
    expect(await resolveCardSourceUrl('project', 'privcover0')).toBeNull();
  });

  it('returns null rather than throwing for a malformed id', async () => {
    expect(await resolveCardSourceUrl('list', 'not-an-objectid')).toBeNull();
    expect(await resolveCardSourceUrl('project', '')).toBeNull();
  });
});

describe('isValidCardId', () => {
  it('accepts the real id shapes and rejects junk', () => {
    expect(isValidCardId('project', 'abc123XYZ_')).toBe(true);
    expect(isValidCardId('profile', 'some.user-name')).toBe(true);
    expect(isValidCardId('list', '0123456789abcdef01234567')).toBe(true);
    expect(isValidCardId('list', 'nope')).toBe(false);
    expect(isValidCardId('project', 'has spaces')).toBe(false);
    expect(isValidCardId('profile', '../../etc')).toBe(false);
  });
});
