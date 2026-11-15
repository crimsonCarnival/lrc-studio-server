import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env: { GENIUS_CLIENT_ACCESS_TOKEN?: string } = {};
vi.mock('../../config/env.js', () => ({ getEnv: () => env }));

import { clearConnectionsCache, getSongConnections } from './song-connections.service.js';

type Fixture = {
  search: { response: { hits: { result: { id: number; title: string; url: string; primary_artist: { name: string } } }[] } };
  song: { response: { song: { title: string; song_relationships: { relationship_type: string; songs: { url: string }[] }[] } } };
};
const load = (): Fixture =>
  JSON.parse(readFileSync(new URL('./__fixtures__/genius-stronger.json', import.meta.url), 'utf8'));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(fx: Fixture, status = 200) {
  const fn = vi.fn(async (url: string | URL) => {
    if (status !== 200) return json({}, status);
    return String(url).includes('/search') ? json(fx.search) : json(fx.song);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const stronger = { track: 'Stronger', artist: 'Kanye West' };

beforeEach(() => {
  clearConnectionsCache();
  env.GENIUS_CLIENT_ACCESS_TOKEN = 'secret-token-xyz';
  vi.unstubAllGlobals();
});

describe('getSongConnections', () => {
  it('maps samples with total and caps songs at 8', async () => {
    stubFetch(load());
    const r = await getSongConnections(stronger);
    expect(r).toMatchObject({ geniusId: 525, album: 'Graduation', releaseDate: '2007-07-31', artist: 'Kanye West' });
    expect(r!.groups.map((g) => g.type)).toEqual(['samples', 'sampled_in', 'covered_by']);
    expect(r!.groups[0]).toMatchObject({ total: 2 });
    expect(r!.groups[0].songs[0]).toMatchObject({ title: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk' });
    const sampledIn = r!.groups[1];
    expect(sampledIn.total).toBe(10);
    expect(sampledIn.songs).toHaveLength(8);
  });

  it('drops performed_live_as and translations', async () => {
    stubFetch(load());
    const types = (await getSongConnections(stronger))!.groups.map((g) => g.type as string);
    expect(types).not.toContain('performed_live_as');
    expect(types).not.toContain('translations');
  });

  it('skips a top hit by another artist and matches the right one', async () => {
    const fn = stubFetch(load());
    const r = await getSongConnections(stronger);
    expect(r!.geniusId).toBe(525);
    expect(String(fn.mock.calls[1][0])).toContain('/songs/525');
  });

  it('matches a "Stronger (Remastered)" title', async () => {
    const fx = load();
    fx.search.response.hits[1].result.title = 'Stronger (Remastered)';
    stubFetch(fx);
    expect((await getSongConnections(stronger))!.geniusId).toBe(525);
  });

  it('returns null when no hit matches', async () => {
    stubFetch(load());
    expect(await getSongConnections({ track: 'Nonexistent', artist: 'Kanye West' })).toBeNull();
  });

  it('returns null without calling fetch when the token is unset', async () => {
    delete env.GENIUS_CLIENT_ACCESS_TOKEN;
    const fn = stubFetch(load());
    expect(await getSongConnections(stronger)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws genius_unauthorized on 401', async () => {
    stubFetch(load(), 401);
    await expect(getSongConnections(stronger)).rejects.toThrow('genius_unauthorized');
  });

  it('drops a song whose url is not https://genius.com', async () => {
    const fx = load();
    fx.song.response.song.song_relationships[0].songs[0].url = 'https://evil.example/x';
    stubFetch(fx);
    const r = await getSongConnections({ geniusId: 525 });
    expect(r!.groups[0].total).toBe(1);
    expect(r!.groups[0].songs.map((s) => s.url)).not.toContain('https://evil.example/x');
  });

  it('second call is served from cache (fetch called once)', async () => {
    const fn = stubFetch(load());
    await getSongConnections({ geniusId: 525 });
    await getSongConnections({ geniusId: 525 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never puts the token in a thrown error message', async () => {
    for (const status of [401, 500]) {
      clearConnectionsCache();
      stubFetch(load(), status);
      const err = await getSongConnections(stronger).catch((e: Error) => e);
      expect((err as Error).message).not.toContain('secret-token-xyz');
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom secret-token-xyz'); }));
    clearConnectionsCache();
    const err = await getSongConnections(stronger).catch((e: Error) => e);
    expect((err as Error).message).toBe('genius_upstream');
  });

  it('tolerates a relationship without songs and a hit without primary_artist', async () => {
    const fx = load();
    (fx.search.response.hits as unknown[]).unshift({ result: { id: 1, title: 'Stronger', url: 'https://genius.com/x' } });
    fx.song.response.song.song_relationships.unshift({ relationship_type: 'samples' } as never);
    stubFetch(fx);
    const r = await getSongConnections(stronger);
    expect(r!.geniusId).toBe(525);
    expect(r!.groups[0].total).toBe(2);
  });

  it('returns null when the song url is not genius.com', async () => {
    const fx = load();
    (fx.song.response.song as { url?: string }).url = 'https://evil.example/x';
    stubFetch(fx);
    expect(await getSongConnections({ geniusId: 525 })).toBeNull();
  });

  it('drops a non-genius thumbnail to null', async () => {
    const fx = load();
    (fx.song.response.song.song_relationships[0].songs[0] as { song_art_image_thumbnail_url?: string })
      .song_art_image_thumbnail_url = 'https://evil.example/t.jpg';
    stubFetch(fx);
    const r = await getSongConnections({ geniusId: 525 });
    expect(r!.groups[0].songs[0].thumbnail).toBeNull();
    expect(r!.groups[0].songs[1].thumbnail).toMatch(/^https:\/\/images\.genius\.com\//);
  });

  it('returns null for geniusId 0 or 1.5 without fetching', async () => {
    const fn = stubFetch(load());
    expect(await getSongConnections({ geniusId: 0 })).toBeNull();
    expect(await getSongConnections({ geniusId: 1.5 })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
