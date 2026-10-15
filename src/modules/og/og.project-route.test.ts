import { describe, it, expect } from 'vitest';

process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.CLIENT_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';

import { parseClientPath, buildProjectMeta, buildProfileMeta, buildListMeta, buildHiddenMeta } from './og.meta.service.js';
import { withDeepLink } from './og.controller.js';
import { buildOgHtml } from './og.html.js';

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

describe('project link-preview title: "Song – Artist, Synced by owner | LRC Studio"', () => {
  const base = { publicId: 'k3x9a2c7qm', lyricLines: [] as string[] };
  const title = (over: Record<string, unknown>, locale: 'en' | 'es' = 'en') =>
    buildProjectMeta({ ...base, ...over }, locale, 'https://api.example').title;

  it('has song, artist and owner', () => {
    expect(title({ songName: 'Creep', songArtist: 'Radiohead', ownerAccountName: '32blunts' }))
      .toBe('Creep – Radiohead, Synced by 32blunts | LRC Studio');
  });

  it('keeps the derived artist display (feat.) as is', () => {
    expect(title({ songName: 'Song', songArtist: 'Drake feat. Rihanna & Kanye', ownerAccountName: 'u1' }))
      .toBe('Song – Drake feat. Rihanna & Kanye, Synced by u1 | LRC Studio');
  });

  it('drops the artist when there is none', () => {
    expect(title({ songName: 'Creep', ownerAccountName: '32blunts' })).toBe('Creep, Synced by 32blunts | LRC Studio');
  });

  it('drops the credit without an owner (legacy URL fallback)', () => {
    expect(title({ songName: 'Creep', songArtist: 'Radiohead' })).toBe('Creep – Radiohead | LRC Studio');
    expect(title({ songName: 'Creep' })).toBe('Creep | LRC Studio');
  });

  it('falls back from song name to the project title, then to the site name', () => {
    expect(title({ title: 'My Mix', ownerAccountName: 'u1' })).toBe('My Mix, Synced by u1 | LRC Studio');
    expect(title({ ownerAccountName: 'u1' })).toBe('LRC Studio, Synced by u1 | LRC Studio');
  });

  it('is localised', () => {
    expect(title({ songName: 'Creep', songArtist: 'Radiohead', ownerAccountName: '32blunts' }, 'es'))
      .toBe('Creep – Radiohead, Sincronizado por 32blunts | LRC Studio');
  });

  it('uses the account name as is, without @', () => {
    expect(title({ songName: 'S', ownerAccountName: 'a.b_c-d' })).toBe('S, Synced by a.b_c-d | LRC Studio');
  });

  it('keeps the plain subject in the image alt', () => {
    const m = buildProjectMeta({ ...base, songName: 'Creep', songArtist: 'Radiohead', ownerAccountName: 'u1' }, 'en', 'https://api.example');
    expect(m.image.alt).toBe('Creep on LRC Studio');
  });

  it('escapes a hostile song name in <title>, og:title and twitter:title (by the renderer, not by string surgery)', () => {
    const meta = buildProjectMeta({ ...base, songName: '"><script>alert(1)</script>', songArtist: 'A & B', ownerAccountName: 'u1' }, 'en', 'https://api.example');
    expect(meta.title).toContain('<script>');
    const html = buildOgHtml({ meta, redirectUrl: 'https://www.lrcstudio.app/', nonce: 'n', lang: 'en', linkLabel: 'x' });
    expect(html).not.toContain('<script>alert(1)</script>');
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; – A &amp; B, Synced by u1 | LRC Studio';
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${escaped}">`);
    expect(html).toContain(`<meta name="twitter:title" content="${escaped}">`);
  });

  it('does not touch profile or list titles', () => {
    expect(buildProfileMeta({ accountName: 'u1', displayName: 'Person' }, 'en', 'https://api.example').title).toBe('Person (@u1) — LRC Studio');
    expect(buildListMeta({ listId: '0123456789abcdef01234567', accountName: 'u1', name: 'My List' }, 'en', 'https://api.example').title).toBe('My List — LRC Studio');
  });

  it('the hidden meta carries no song, artist or owner', () => {
    const hidden = JSON.stringify(buildHiddenMeta('en'));
    expect(hidden).not.toMatch(/Synced by|Sincronizado por|Creep|Radiohead|32blunts/);
  });
});
