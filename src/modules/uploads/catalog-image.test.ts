import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v2 as cloudinary } from 'cloudinary';

vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));

import { isCatalogImageUrl, generateCatalogImageSignature } from './uploads.service.js';

beforeAll(() => {
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  process.env.CLOUDINARY_API_KEY = 'key';
  process.env.CLOUDINARY_API_SECRET = 'secret';
});

const good = 'https://res.cloudinary.com/demo/image/upload/v123/catalog/user1/abc.webp';

describe('isCatalogImageUrl', () => {
  it('accepts a well-formed catalog URL', () => {
    expect(isCatalogImageUrl(good)).toBe(true);
    expect(isCatalogImageUrl('https://res.cloudinary.com/demo/image/upload/c_fill,w_600,h_600,f_webp,q_auto/v1/catalog/u/a.webp')).toBe(true);
  });

  it.each([
    ['another cloud name', 'https://res.cloudinary.com/other/image/upload/v1/catalog/u/a.webp'],
    ['http scheme', good.replace('https:', 'http:')],
    ['lookalike host', 'https://res.cloudinary.com.evil.test/demo/image/upload/v1/catalog/u/a.webp'],
    ['userinfo host trick', 'https://res.cloudinary.com@evil.test/demo/image/upload/v1/catalog/u/a.webp'],
    ['credentials', 'https://user:pw@res.cloudinary.com/demo/image/upload/v1/catalog/u/a.webp'],
    ['explicit port', 'https://res.cloudinary.com:8443/demo/image/upload/v1/catalog/u/a.webp'],
    ['no /catalog/ segment', 'https://res.cloudinary.com/demo/image/upload/v1/covers/u/a.webp'],
    ['video resource type', 'https://res.cloudinary.com/demo/video/upload/v1/catalog/u/a.mp4'],
    ['query string', good + '?x=1'],
    ['fragment', good + '#x'],
    ['dot-dot segment', 'https://res.cloudinary.com/demo/image/upload/v1/foo/../catalog/u/a.webp'],
    ['encoded dot-dot', 'https://res.cloudinary.com/demo/image/upload/v1/x/%2e%2e/catalog/u/a.webp'],
    ['leading space', ' ' + good],
    ['trailing newline', good + '\n'],
    ['embedded tab', good.replace('catalog', 'cata\tlog')],
    [':443 port', good.replace('.com/', '.com:443/')],
    ['fullwidth-dot host', 'https://res．cloudinary.com/demo/image/upload/v1/catalog/u/a.webp'],
    ['trailing-dot host', 'https://res.cloudinary.com./demo/image/upload/v1/catalog/u/a.webp'],
    ['encoded slash', 'https://res.cloudinary.com/demo/image/upload/v1/catalog%2Fu/a.webp'],
    ['deeper folder', 'https://res.cloudinary.com/demo/image/upload/v1/catalog/u/sub/a.webp'],
    ['l_fetch overlay', 'https://res.cloudinary.com/demo/image/upload/l_fetch:aHR0cHM6Ly9ldmls/v1/catalog/u/a.webp'],
    ['l_ overlay', 'https://res.cloudinary.com/demo/image/upload/c_fill,l_logo/v1/catalog/u/a.webp'],
    ['u_ underlay', 'https://res.cloudinary.com/demo/image/upload/u_evil/v1/catalog/u/a.webp'],
    ['other transformation', 'https://res.cloudinary.com/demo/image/upload/w_100/v1/catalog/u/a.webp'],
    ['two transformation segments', 'https://res.cloudinary.com/demo/image/upload/c_fill/w_5/v1/catalog/u/a.webp'],
    ['unparsable', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isCatalogImageUrl(url)).toBe(false);
  });

  it.each([null, undefined, 42, {}, ['x']])('rejects non-string %j', (v) => {
    expect(isCatalogImageUrl(v)).toBe(false);
  });

  it('rejects a very long string', () => {
    expect(isCatalogImageUrl(good + 'a'.repeat(3000))).toBe(false);
  });

  it('binds the folder to uploaderId when given', () => {
    expect(isCatalogImageUrl(good, 'user1')).toBe(true);
    expect(isCatalogImageUrl(good, 'user2')).toBe(false);
  });

  it('accepts no transformation or exactly the signed one', () => {
    expect(isCatalogImageUrl('https://res.cloudinary.com/demo/image/upload/catalog/u/a.webp')).toBe(true);
    expect(isCatalogImageUrl('https://res.cloudinary.com/demo/image/upload/c_fill,w_600,h_600,f_webp,q_auto/catalog/u/a.webp')).toBe(true);
  });

  it('accepts a transformation plus version', () => {
    expect(isCatalogImageUrl('https://res.cloudinary.com/demo/image/upload/c_fill,w_600,h_600,f_webp,q_auto/v1700000000/catalog/user1/a_b-1.webp', 'user1')).toBe(true);
  });

  it('reads the cloud name at call time', () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'other';
    expect(isCatalogImageUrl(good)).toBe(false);
    process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  });
});

describe('generateCatalogImageSignature', () => {
  it('signs a per-user catalog folder with the fixed transformation', async () => {
    const res = await generateCatalogImageSignature({ fileName: 'a.png', fileSize: 1024 }, 'user1', '127.0.0.1');
    expect(res).toMatchObject({
      folder: 'catalog/user1',
      transformation: 'c_fill,w_600,h_600,f_webp,q_auto',
      resourceType: 'image',
      cloudName: 'demo',
    });
    const expected = cloudinary.utils.api_sign_request(
      { timestamp: res.timestamp as number, folder: 'catalog/user1', transformation: 'c_fill,w_600,h_600,f_webp,q_auto' },
      'secret',
    );
    expect(res.signature).toBe(expected);
  });

  it('rejects bad extensions and oversize files', async () => {
    expect(await generateCatalogImageSignature({ fileName: 'a.exe' }, 'u', 'ip')).toMatchObject({ status: 400 });
    expect(await generateCatalogImageSignature({ fileSize: 6 * 1024 * 1024 }, 'u', 'ip')).toMatchObject({ status: 400 });
  });
});
