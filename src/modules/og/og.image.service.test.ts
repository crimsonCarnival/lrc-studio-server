import { describe, it, expect } from 'vitest';

process.env.CORS_ORIGIN ||= 'https://www.lrcstudio.app';
process.env.APP_URL ||= 'https://www.lrcstudio.app';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/og-test';
process.env.JWT_SECRET ||= 'test-jwt-secret-value-not-used-here';
process.env.COOKIE_SECRET ||= 'test-cookie-secret-value-not-used-here';
process.env.CLOUDINARY_CLOUD_NAME ||= 'testcloud';

import {
  DEFAULT_OG_IMAGE_FALLBACK,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  buildOgImageUrl,
  resolveOgImageUrl,
} from './og.image.service.js';
import { escapeHtml, buildOgHtml } from './og.html.js';
import {
  OG_LOCALE_CODE,
  alternateLocaleCodes,
  resolveLocale,
  getOgStrings,
  interpolate,
} from './og.strings.js';
import { buildHiddenMeta } from './og.meta.service.js';

const CLOUD = 'testcloud';
const OWN = `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/cover.jpg`;

// ─── The SSRF / open-redirect guard ──────────────────────────────────────────

describe('buildOgImageUrl', () => {
  it('rewrites an own-cloud asset to an exact 1200x630 PNG derivative', () => {
    const out = buildOgImageUrl(OWN, CLOUD);
    expect(out).not.toBeNull();
    expect(out).toContain(`w_${OG_IMAGE_WIDTH}`);
    expect(out).toContain(`h_${OG_IMAGE_HEIGHT}`);
    expect(out).toContain('c_fill');
    expect(out).toContain('f_png');
    expect(out).toContain('/cover.jpg');
    expect(out!.startsWith('https://res.cloudinary.com/')).toBe(true);
  });

  it('keeps the version segment but drops a pre-existing leading transformation', () => {
    // A leading transformation would chain AFTER ours and could undo the size.
    const chained = `https://res.cloudinary.com/${CLOUD}/image/upload/w_80,h_80,c_thumb/v1/cover.jpg`;
    const out = buildOgImageUrl(chained, CLOUD)!;
    expect(out).not.toContain('c_thumb');
    expect(out).not.toContain('w_80');
    expect(out).toContain('/v1/cover.jpg');
  });

  // Each of these would otherwise turn the endpoint into an open redirect, and
  // a fetch primitive for any crawler that follows it.
  const rejected: [string, string | null | undefined][] = [
    ['a foreign host', 'https://evil.example.com/image/upload/v1/x.jpg'],
    ['a look-alike host', 'https://res.cloudinary.com.evil.example.com/testcloud/image/upload/v1/x.jpg'],
    ['plain http', `http://res.cloudinary.com/${CLOUD}/image/upload/v1/x.jpg`],
    ['another tenant’s cloud', 'https://res.cloudinary.com/someoneelse/image/upload/v1/x.jpg'],
    ['a video asset', `https://res.cloudinary.com/${CLOUD}/video/upload/v1/x.mp4`],
    ['a private delivery type', `https://res.cloudinary.com/${CLOUD}/image/authenticated/v1/x.jpg`],
    ['a path with no asset', `https://res.cloudinary.com/${CLOUD}/image/upload/`],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:image/png;base64,AAAA'],
    ['a protocol-relative URL', '//res.cloudinary.com/testcloud/image/upload/v1/x.jpg'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(rejected)('rejects %s', (_label, url) => {
    expect(buildOgImageUrl(url, CLOUD)).toBeNull();
  });

  it('rejects everything when no cloud name is configured', () => {
    expect(buildOgImageUrl(OWN, undefined)).toBeNull();
    expect(buildOgImageUrl(OWN, '')).toBeNull();
  });
});

describe('resolveOgImageUrl', () => {
  it('falls back to the brand card for every rejected source', () => {
    for (const bad of ['https://evil.example.com/x.jpg', '', null, undefined]) {
      expect(resolveOgImageUrl(bad)).toBe(DEFAULT_OG_IMAGE_FALLBACK);
    }
  });

  it('gives a private and a foreign asset the identical fallback, leaking nothing', () => {
    expect(resolveOgImageUrl(null)).toBe(resolveOgImageUrl('https://evil.example.com/x.jpg'));
  });

  it('uses the canonical www host for the fallback', () => {
    // index.html's canonical, robots.txt's Sitemap and sitemap.xml all use www.
    expect(DEFAULT_OG_IMAGE_FALLBACK).toContain('https://www.lrcstudio.app/');
  });
});

// ─── Locale ──────────────────────────────────────────────────────────────────

describe('resolveLocale', () => {
  it('prefers ?hl= over Accept-Language', () => {
    expect(resolveLocale('es', 'en-US,en;q=0.9')).toBe('es');
    expect(resolveLocale('en', 'es-CO,es;q=0.9')).toBe('en');
  });

  it('honours Accept-Language q-values rather than document order', () => {
    expect(resolveLocale(null, 'fr;q=1.0, es;q=0.8, en;q=0.2')).toBe('es');
    expect(resolveLocale(null, 'es;q=0.3, en;q=0.9')).toBe('en');
  });

  it('ignores a q=0 entry', () => {
    expect(resolveLocale(null, 'es;q=0, en;q=0.5')).toBe('en');
  });

  it('falls back to en for an unknown or junk tag', () => {
    expect(resolveLocale('de', null)).toBe('en');
    expect(resolveLocale('', null)).toBe('en');
    expect(resolveLocale(null, null)).toBe('en');
    expect(resolveLocale('../../etc', 'zz-ZZ')).toBe('en');
  });

  it('accepts a regional tag', () => {
    expect(resolveLocale('es-CO', null)).toBe('es');
    expect(resolveLocale(null, 'en-GB')).toBe('en');
  });
});

describe('locale codes', () => {
  it('maps to the OG forms', () => {
    expect(OG_LOCALE_CODE.en).toBe('en_US');
    expect(OG_LOCALE_CODE.es).toBe('es_CO');
  });

  it('alternates are the other locale only, never itself', () => {
    expect(alternateLocaleCodes('en')).toEqual(['es_CO']);
    expect(alternateLocaleCodes('es')).toEqual(['en_US']);
  });
});

describe('strings', () => {
  it('provides every locale a non-empty value for the same keys', () => {
    const en = getOgStrings('en');
    const es = getOgStrings('es');
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value, key).toBe('string');
      expect((value as string).length, key).toBeGreaterThan(0);
      expect((es as Record<string, string>)[key].length, key).toBeGreaterThan(0);
    }
  });

  it('interpolate replaces known vars and blanks unknown ones', () => {
    expect(interpolate('{a} and {b}', { a: 'x', b: 'y' })).toBe('x and y');
    expect(interpolate('{a} and {missing}', { a: 'x' })).toBe('x and ');
  });
});

// ─── HTML escaping on the legacy crawler page ────────────────────────────────

describe('escapeHtml', () => {
  it('neutralises tag and attribute break-out', () => {
    const out = escapeHtml('"><script>alert(1)</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('"');
  });

  it('escapes single quotes and ampersands', () => {
    expect(escapeHtml("' onload='x")).toBe('&#39; onload=&#39;x');
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('escapes & before the entities it introduces', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('buildOgHtml', () => {
  const hostile = '"><script>alert(1)</script>';

  it('never lets a hostile title break out of an attribute or into a tag', () => {
    const meta = { ...buildHiddenMeta('en'), title: hostile, description: hostile };
    const html = buildOgHtml({
      meta,
      redirectUrl: 'https://www.lrcstudio.app/',
      nonce: 'test-nonce',
      lang: 'en',
      linkLabel: 'View',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    // The hostile string must appear only in escaped form. (A bare `"><` check
    // is useless here: `<html lang="en"><head>` contains it in any document.)
    expect(html).not.toContain(hostile);
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    // The only script element present is the nonce'd redirect.
    expect(html.match(/<script/gi)?.length).toBe(1);
    expect(html).toContain('nonce="test-nonce"');
  });

  it('cannot be closed early through the redirect URL inside the script', () => {
    const meta = buildHiddenMeta('en');
    const html = buildOgHtml({
      meta,
      redirectUrl: 'https://x.test/"</script><script>alert(1)</script>',
      nonce: 'n',
      lang: 'en',
      linkLabel: 'View',
    });
    expect(html).not.toContain('</script><script>');
    expect(html.match(/<script/gi)?.length).toBe(1);
  });

  it('carries the locale through to the document language', () => {
    const html = buildOgHtml({
      meta: buildHiddenMeta('es'),
      redirectUrl: 'https://www.lrcstudio.app/',
      nonce: 'n',
      lang: 'es',
      linkLabel: 'Ver',
    });
    expect(html).toContain('lang="es"');
  });
});
