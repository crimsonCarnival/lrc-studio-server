import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as { GENIUS_CLIENT_ACCESS_TOKEN?: string });
vi.mock('../../config/env.js', () => ({ getEnv: () => env }));
vi.mock('../genius/genius.client.js', async (orig) => ({
  ...(await orig<typeof import('../genius/genius.client.js')>()),
  searchSong: vi.fn(),
  getArtist: vi.fn(),
}));
vi.mock('./catalog.admin.service.js', async (orig) => ({
  ...(await orig<typeof import('./catalog.admin.service.js')>()),
  assertManager: vi.fn(),
}));
vi.mock('../uploads/uploads.service.js', async (orig) => ({
  ...(await orig<typeof import('../uploads/uploads.service.js')>()),
  uploadCatalogImageBuffer: vi.fn(),
}));

import { searchSong, getArtist, type GeniusHit } from '../genius/genius.client.js';
import { assertManager } from './catalog.admin.service.js';
import { uploadCatalogImageBuffer } from '../uploads/uploads.service.js';
import { isGeniusImageUrl, searchGeniusArtists, copyGeniusArtistPhoto } from './catalog.genius.service.js';

const hits = (): GeniusHit[] =>
  JSON.parse(readFileSync(new URL('../genius/__fixtures__/genius-search-artists.json', import.meta.url), 'utf8')).response.hits.map(
    (x: { result: GeniusHit }) => x.result,
  );
const search = vi.mocked(searchSong);

beforeEach(() => {
  search.mockReset();
  env.GENIUS_CLIENT_ACCESS_TOKEN = 'secret-token-xyz';
  vi.unstubAllGlobals();
});

describe('isGeniusImageUrl', () => {
  it('accepts images.genius.com and filepicker hosts', () => {
    expect(isGeniusImageUrl('https://images.genius.com/abc.1000x1000x1.png')).toBe(true);
    expect(isGeniusImageUrl('https://filepicker-images.genius.com/u4uhfac3uem')).toBe(true);
  });
  it('rejects placeholder, http, lookalike hosts, credentials and non-strings', () => {
    expect(isGeniusImageUrl('https://assets.genius.com/images/default_cover_image.png')).toBe(false);
    expect(isGeniusImageUrl('http://images.genius.com/a.png')).toBe(false);
    expect(isGeniusImageUrl('https://images.genius.com.evil.test/a.png')).toBe(false);
    expect(isGeniusImageUrl('https://x@images.genius.com/a.png')).toBe(false);
    expect(isGeniusImageUrl('https://images.genius.com:8443/a.png')).toBe(false);
    expect(isGeniusImageUrl('https://images.genius.com\\@evil.test/x.png')).toBe(false);
    expect(isGeniusImageUrl('https://images.gen\nius.com/a.png')).toBe(false);
    expect(isGeniusImageUrl('https://IMAGES.genius.com/a.png')).toBe(false);
    expect(isGeniusImageUrl('https://assets.genius.com/Images/Default_cover_image.png')).toBe(false);
    expect(isGeniusImageUrl(42)).toBe(false);
    expect(isGeniusImageUrl(undefined)).toBe(false);
  });
});

describe('searchGeniusArtists', () => {
  it('returns distinct artists in hit order, exact name first', async () => {
    search.mockResolvedValue(hits());
    const r = await searchGeniusArtists('u1', ' kanye west ');
    expect(r?.map((m) => m.geniusId)).toEqual([11, 10, 13]);
    expect(r?.[0]).toEqual({
      geniusId: 11,
      name: 'Kanye West',
      imageUrl: 'https://images.genius.com/bbb.1000x1000x1.png',
      url: 'https://genius.com/artists/Kanye-West',
    });
  });

  it('caps at 5', async () => {
    search.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        id: i, title: 't', url: 'https://genius.com/t',
        primary_artist: { id: 100 + i, name: `A${i}`, url: `https://genius.com/artists/A${i}`, image_url: `https://images.genius.com/${i}.jpg` },
      })),
    );
    expect(await searchGeniusArtists('u1', 'zzz')).toHaveLength(5);
  });

  it('drops placeholder and disallowed images', async () => {
    search.mockResolvedValue(hits());
    const ids = (await searchGeniusArtists('u1', 'x'))?.map((m) => m.geniusId);
    expect(ids).not.toContain(12);
    expect(ids).not.toContain(14);
  });

  it('keeps a later hit of the same artist when the first has no usable image', async () => {
    const a = { id: 1, name: 'Dup', url: 'https://genius.com/artists/Dup' };
    search.mockResolvedValue([
      { id: 1, title: 't', url: 'u', primary_artist: { ...a, image_url: 'https://assets.genius.com/images/default_cover_image.png' } },
      { id: 2, title: 't', url: 'u', primary_artist: { ...a, image_url: 'https://images.genius.com/ok.jpg' } },
    ]);
    expect((await searchGeniusArtists('u1', 'x'))?.map((m) => m.geniusId)).toEqual([1]);
  });

  it('drops entries without an id', async () => {
    search.mockResolvedValue(hits());
    expect((await searchGeniusArtists('u1', 'x'))?.map((m) => m.name)).not.toContain('No Id');
  });

  it('denies a non-manager without calling Genius', async () => {
    vi.mocked(assertManager).mockResolvedValueOnce({ error: 'x', status: 403, code: 'CATALOG_FORBIDDEN' });
    expect(await searchGeniusArtists('u1', 'x')).toEqual({ error: 'x', status: 403, code: 'CATALOG_FORBIDDEN' });
    expect(search).not.toHaveBeenCalled();
    expect(assertManager).toHaveBeenCalledWith('u1');
  });

  it('returns null when Genius is not configured', async () => {
    search.mockResolvedValue(null);
    expect(await searchGeniusArtists('u1', 'x')).toBeNull();
  });

  it('propagates genius_unauthorized', async () => {
    search.mockRejectedValue(new Error('genius_unauthorized'));
    await expect(searchGeniusArtists('u1', 'x')).rejects.toThrow('genius_unauthorized');
  });
});

describe('getArtist', () => {
  const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  it('maps response.artist', async () => {
    const real = await vi.importActual<typeof import('../genius/genius.client.js')>('../genius/genius.client.js');
    stub({ response: { artist: { id: 5, name: 'N', url: 'https://genius.com/artists/N', image_url: 'https://images.genius.com/a.jpg', extra: 1 } } });
    expect(await real.getArtist(5)).toEqual({ id: 5, name: 'N', url: 'https://genius.com/artists/N', image_url: 'https://images.genius.com/a.jpg' });
    stub({ response: { artist: { id: 6, name: 'M', url: 'u' } } });
    expect((await real.getArtist(6))?.image_url).toBeNull();
    stub({ response: {} });
    await expect(real.getArtist(7)).rejects.toThrow('genius_upstream');
  });
  it('distinguishes a 404 for artists only', async () => {
    const real = await vi.importActual<typeof import('../genius/genius.client.js')>('../genius/genius.client.js');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await expect(real.getArtist(5)).rejects.toThrow('genius_not_found');
    await expect(real.getSong(5)).rejects.toThrow('genius_upstream');
  });
  it('null without a token', async () => {
    const real = await vi.importActual<typeof import('../genius/genius.client.js')>('../genius/genius.client.js');
    delete env.GENIUS_CLIENT_ACCESS_TOKEN;
    expect(await real.getArtist(5)).toBeNull();
  });
  it('rejects invalid ids before any fetch', async () => {
    const real = await vi.importActual<typeof import('../genius/genius.client.js')>('../genius/genius.client.js');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const bad of [NaN, -1, 1.5, 1e21, '1' as unknown as number]) {
      await expect(real.getArtist(bad)).rejects.toThrow('genius_invalid_id');
      await expect(real.getSong(bad)).rejects.toThrow('genius_invalid_id');
    }
    expect(f).not.toHaveBeenCalled();
  });
  it('thrown errors never contain the token', async () => {
    const real = await vi.importActual<typeof import('../genius/genius.client.js')>('../genius/genius.client.js');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom secret-token-xyz'); }));
    const err = await real.getArtist(5).catch((e: Error) => e);
    expect((err as Error).message).toBe('genius_upstream');
    expect((err as Error).message).not.toContain('secret-token-xyz');
  });
});

describe('copyGeniusArtistPhoto', () => {
  const ADMIN = '64b000000000000000000001';
  const IMG = 'https://images.genius.com/bbb.1000x1000x1.png';
  const PAGE = 'https://genius.com/artists/Kanye-West';
  const CANON = `https://res.cloudinary.com/democloud/image/upload/c_fill,w_600,h_600,f_webp,q_auto/v1/catalog/${ADMIN}/x.webp`;
  const MB = 1024 * 1024;

  const artist = (over: Record<string, unknown> = {}) => ({ id: 11, name: 'Kanye West', url: PAGE, image_url: IMG, ...over });
  const imgRes = (body: BodyInit | null = new Uint8Array([1, 2, 3]), headers: Record<string, string> = {}, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'image/png', 'content-length': '3', ...headers } });
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.mocked(assertManager).mockReset().mockResolvedValue(null);
    vi.mocked(getArtist).mockReset().mockResolvedValue(artist());
    vi.mocked(uploadCatalogImageBuffer).mockReset().mockResolvedValue(CANON);
    fetchMock.mockReset().mockImplementation(async () => imgRes());
    vi.stubGlobal('fetch', fetchMock);
  });

  it('copies the re-resolved image and returns the canonical URL and page', async () => {
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toEqual({ imageUrl: CANON, sourceUrl: PAGE });
    expect(getArtist).toHaveBeenCalledWith(11);
    expect(fetchMock).toHaveBeenCalledWith(IMG, expect.objectContaining({ redirect: 'error' }));
    const [buf, type, user] = vi.mocked(uploadCatalogImageBuffer).mock.calls[0];
    expect([...buf]).toEqual([1, 2, 3]);
    expect([type, user]).toEqual(['image/png', ADMIN]);
  });

  it('takes no URL parameter', () => {
    expect(copyGeniusArtistPhoto.length).toBe(2);
  });

  it('refuses a non-manager before anything else', async () => {
    vi.mocked(assertManager).mockResolvedValue({ error: 'x', status: 403, code: 'CATALOG_FORBIDDEN' });
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 403 });
    expect(getArtist).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a placeholder or foreign-host image_url', async () => {
    for (const image_url of ['https://assets.genius.com/images/default_cover_image.png', 'https://evil.test/a.png', null]) {
      vi.mocked(getArtist).mockResolvedValue(artist({ image_url }));
      expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 422, code: 'CATALOG_GENIUS_IMAGE_REJECTED' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-genius page url', async () => {
    vi.mocked(getArtist).mockResolvedValue(artist({ url: 'https://evil.test/artists/x' }));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a redirect fails closed', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: unexpected redirect'));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 502, code: 'CATALOG_GENIUS_UPSTREAM' });
    expect(uploadCatalogImageBuffer).not.toHaveBeenCalled();
  });

  it('refuses Content-Length over 5 MB', async () => {
    fetchMock.mockResolvedValue(imgRes(new Uint8Array(3), { 'content-length': String(5 * MB + 1) }));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 422, code: 'CATALOG_GENIUS_IMAGE_REJECTED' });
    expect(uploadCatalogImageBuffer).not.toHaveBeenCalled();
  });

  it('refuses a lying Content-Length', async () => {
    fetchMock.mockResolvedValue(imgRes(new Uint8Array(6 * MB), { 'content-length': '100' }));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 422, code: 'CATALOG_GENIUS_IMAGE_REJECTED' });
    expect(uploadCatalogImageBuffer).not.toHaveBeenCalled();
  });

  it('refuses text/html and image/svg+xml', async () => {
    for (const ct of ['text/html', 'image/svg+xml', '', 'image/png,xyz', 'image/x-anything', 'image/avif']) {
      fetchMock.mockResolvedValue(imgRes(new Uint8Array(3), { 'content-type': ct }));
      expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 422 });
    }
    expect(uploadCatalogImageBuffer).not.toHaveBeenCalled();
  });

  it('refuses a non-ok image response as upstream failure', async () => {
    fetchMock.mockResolvedValue(imgRes(null, {}, 500));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 502 });
  });

  it('times out at 8 s', async () => {
    await copyGeniusArtistPhoto(ADMIN, 11);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 502, code: 'CATALOG_GENIUS_UPSTREAM' });
  });

  it('unknown geniusId → 404', async () => {
    vi.mocked(getArtist).mockRejectedValue(new Error('genius_not_found'));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 404, code: 'CATALOG_GENIUS_NOT_FOUND' });
    vi.mocked(getArtist).mockRejectedValue(new Error('genius_invalid_id'));
    expect(await copyGeniusArtistPhoto(ADMIN, -1)).toMatchObject({ status: 404 });
  });

  it('accepts jpeg/webp/gif and normalises params', async () => {
    fetchMock.mockImplementation(async () => imgRes(new Uint8Array(3), { 'content-type': 'Image/JPEG; charset=binary' }));
    await copyGeniusArtistPhoto(ADMIN, 11);
    expect(vi.mocked(uploadCatalogImageBuffer).mock.calls[0][1]).toBe('image/jpeg');
  });

  it('genius_unauthorized → 503 unavailable', async () => {
    vi.mocked(getArtist).mockRejectedValue(new Error('genius_unauthorized'));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 503, code: 'CATALOG_GENIUS_UNAVAILABLE' });
  });

  it('no Genius token → 503', async () => {
    vi.mocked(getArtist).mockResolvedValue(null);
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 503, code: 'CATALOG_GENIUS_UNAVAILABLE' });
  });

  it('unconfigured storage → 503; upstream errors stay opaque', async () => {
    vi.mocked(uploadCatalogImageBuffer).mockRejectedValue(new Error('storage_unconfigured'));
    expect(await copyGeniusArtistPhoto(ADMIN, 11)).toMatchObject({ status: 503, code: 'CATALOG_GENIUS_UNAVAILABLE' });
    vi.mocked(getArtist).mockRejectedValue(new Error('genius_upstream secret-token-xyz'));
    const r = await copyGeniusArtistPhoto(ADMIN, 11);
    expect(r).toMatchObject({ status: 502 });
    expect(JSON.stringify(r)).not.toContain('secret-token-xyz');
  });
});
