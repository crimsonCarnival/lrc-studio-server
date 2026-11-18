import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as { GENIUS_CLIENT_ACCESS_TOKEN?: string });
vi.mock('../../config/env.js', () => ({ getEnv: () => env }));
vi.mock('../genius/genius.client.js', async (orig) => ({
  ...(await orig<typeof import('../genius/genius.client.js')>()),
  searchSong: vi.fn(),
}));

import { searchSong, getArtist, type GeniusHit } from '../genius/genius.client.js';
import { isGeniusImageUrl, searchGeniusArtists } from './catalog.genius.service.js';

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
    expect(isGeniusImageUrl(42)).toBe(false);
    expect(isGeniusImageUrl(undefined)).toBe(false);
  });
});

describe('searchGeniusArtists', () => {
  it('returns distinct artists in hit order, exact name first', async () => {
    search.mockResolvedValue(hits());
    const r = await searchGeniusArtists(' kanye west ');
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
    expect(await searchGeniusArtists('zzz')).toHaveLength(5);
  });

  it('drops placeholder and disallowed images', async () => {
    search.mockResolvedValue(hits());
    const ids = (await searchGeniusArtists('x'))?.map((m) => m.geniusId);
    expect(ids).not.toContain(12);
    expect(ids).not.toContain(14);
  });

  it('drops entries without an id', async () => {
    search.mockResolvedValue(hits());
    expect((await searchGeniusArtists('x'))?.map((m) => m.name)).not.toContain('No Id');
  });

  it('returns null when Genius is not configured', async () => {
    search.mockResolvedValue(null);
    expect(await searchGeniusArtists('x')).toBeNull();
  });

  it('propagates genius_unauthorized', async () => {
    search.mockRejectedValue(new Error('genius_unauthorized'));
    await expect(searchGeniusArtists('x')).rejects.toThrow('genius_unauthorized');
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
  it('null without a token', async () => {
    const real = await vi.importActual<typeof import('../genius/genius.client.js')>('../genius/genius.client.js');
    delete env.GENIUS_CLIENT_ACCESS_TOKEN;
    expect(await real.getArtist(5)).toBeNull();
    expect(getArtist).toBeDefined();
  });
});
