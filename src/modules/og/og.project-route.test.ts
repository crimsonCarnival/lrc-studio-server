import { describe, it, expect } from 'vitest';

process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.CLIENT_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';

import { parseClientPath, buildProjectMeta, buildProfileMeta, buildListMeta } from './og.meta.service.js';
import { withDeepLink } from './og.controller.js';

describe('parseClientPath: slug project URLs', () => {
  it('takes the project id from the last 10 characters of the segment', () => {
    expect(parseClientPath('/32blunts/projects/radiohead-creep-k3x9a2c7qm'))
      .toEqual({ kind: 'project', publicId: 'k3x9a2c7qm' });
  });

  it('handles ids that contain - and _', () => {
    expect(parseClientPath('/32blunts/projects/radiohead-creep--abc_def-x'))
      .toEqual({ kind: 'project', publicId: '-abc_def-x' });
  });

  it('accepts a bare id, the /edit suffix and percent-encoded non-ASCII slugs', () => {
    expect(parseClientPath('/a.b/projects/k3x9a2c7qm')).toEqual({ kind: 'project', publicId: 'k3x9a2c7qm' });
    expect(parseClientPath('/a/projects/x-k3x9a2c7qm/edit')).toEqual({ kind: 'project', publicId: 'k3x9a2c7qm' });
    expect(parseClientPath(`/a/projects/${encodeURIComponent('ありがとう-k3x9a2c7qm')}`))
      .toEqual({ kind: 'project', publicId: 'k3x9a2c7qm' });
  });

  it('ignores a stale slug or account name (they are cosmetic)', () => {
    expect(parseClientPath('/someone-else/projects/old-slug-k3x9a2c7qm'))
      .toEqual({ kind: 'project', publicId: 'k3x9a2c7qm' });
  });

  it('still parses the legacy /project/:id and rejects malformed shapes', () => {
    expect(parseClientPath('/project/k3x9a2c7qm')).toEqual({ kind: 'project', publicId: 'k3x9a2c7qm' });
    for (const bad of ['/a/projects/short', '/a/projects/x-k3x9a2c7qm/other', '/a/projects/x/y/z', '/a/projects/' + 'x'.repeat(10) + '%00']) {
      expect(parseClientPath(bad).kind).toBe('unknown');
    }
  });

  it('parses /:accountName/lists/:id', () => {
    expect(parseClientPath('/a.b/lists/507f1f77bcf86cd799439011'))
      .toEqual({ kind: 'list', accountName: 'a.b', listId: '507f1f77bcf86cd799439011' });
    expect(parseClientPath('/a/lists/nope').kind).toBe('unknown');
  });
});

describe('buildProjectMeta canonical', () => {
  const base = { publicId: 'k3x9a2c7qm', songName: 'Creep', songArtist: 'Radiohead', lyricLines: [] as string[] };

  it('is the slug URL on the web origin when the owner is known', () => {
    const m = buildProjectMeta({ ...base, ownerAccountName: '32blunts' }, 'en', 'https://api.example');
    expect(m.canonical).toBe('https://www.lrcstudio.app/32blunts/projects/radiohead-creep-k3x9a2c7qm');
  });

  it('uses the stored slug when present', () => {
    const m = buildProjectMeta({ ...base, slug: 'stored', ownerAccountName: 'u1' }, 'en', 'https://api.example');
    expect(m.canonical).toBe('https://www.lrcstudio.app/u1/projects/stored-k3x9a2c7qm');
  });

  it('falls back to the legacy URL for an ownerless project', () => {
    expect(buildProjectMeta(base, 'en', 'https://api.example').canonical).toBe('https://www.lrcstudio.app/project/k3x9a2c7qm');
  });
});

describe('withDeepLink', () => {
  it('keeps a valid seek time and list, drops junk', () => {
    expect(withDeepLink('https://x/y', { s: '12', list: 'abc_DEF-1' })).toBe('https://x/y?s=12&list=abc_DEF-1');
    expect(withDeepLink('https://x/y', { s: '<x>', list: 'a b' })).toBe('https://x/y');
  });
});

describe('profiles live at /:accountName', () => {
  it('parses a bare account name as a profile', () => {
    expect(parseClientPath('/32blunts')).toEqual({ kind: 'profile', accountName: '32blunts' });
    expect(parseClientPath('/a.b_c-d?hl=es')).toEqual({ kind: 'profile', accountName: 'a.b_c-d' });
  });

  it('never treats a client route as a profile', () => {
    for (const r of ['admin', 'settings', 'library', 'feed', 'home', 'search', 'notifications', 'projects', 'profile', 'og']) {
      expect(parseClientPath('/' + r).kind, r).toBe('unknown');
    }
    expect(parseClientPath('/explore').kind).toBe('explore');
    expect(parseClientPath('/leaderboard').kind).toBe('leaderboard');
  });

  it('still parses the legacy /profile/... URLs', () => {
    expect(parseClientPath('/profile/someone')).toEqual({ kind: 'profile', accountName: 'someone' });
    expect(parseClientPath('/profile/someone/lists/0123456789abcdef01234567'))
      .toEqual({ kind: 'list', accountName: 'someone', listId: '0123456789abcdef01234567' });
  });

  it('reports bare canonicals', () => {
    expect(buildProfileMeta({ accountName: 'u1' }, 'en', 'https://api.example').canonical).toBe('https://www.lrcstudio.app/u1');
    expect(buildListMeta({ listId: '0123456789abcdef01234567', accountName: 'u1', name: 'L' }, 'en', 'https://api.example').canonical)
      .toBe('https://www.lrcstudio.app/u1/lists/0123456789abcdef01234567');
  });
});
