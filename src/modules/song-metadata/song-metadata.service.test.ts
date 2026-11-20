import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({}) as { TRACK_METADATA_CLIENT_ID?: string; TRACK_METADATA_CLIENT_SECRET?: string });
vi.mock('../../config/env.js', () => ({ getEnv: () => env }));

import { lookupTrack, searchTracks } from './song-metadata.service.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const itunes = {
  results: [
    { trackId: 1, trackName: 'Castles', artistName: 'Tom MacDonald', collectionName: 'Castles', releaseDate: '2021-01-01' },
    { trackId: 2, trackName: 'castles', artistName: 'Lil Peep & Lil Tracy', collectionName: 'Castles', releaseDate: '2016-05-01' },
  ],
};

let urls: string[];
let seq = 0;
beforeEach(() => {
  urls = [];
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }));
}

// Each test uses its own song name: results are cached per query.
const song = () => `castles ${++seq}`;

describe('searchTracks', () => {
  it('ranks the requested artist first and leaves featured artists out of the provider query', async () => {
    const name = song();
    stubFetch((url) => url.includes('itunes')
      ? json({ results: itunes.results.map((r) => ({ ...r, trackName: r.trackName.replace(/castles/i, name) })) })
      : json({ data: [] }));
    const out = await searchTracks({ songName: name, artistName: 'LIL PEEP', featuredArtists: ['Lil Tracy'] });
    expect('results' in out && out.results[0]).toMatchObject({ artist: 'Lil Peep & Lil Tracy', artistMatch: true, featuredMatch: true });
    const term = new URL(urls.find((u) => u.includes('itunes'))!).searchParams.get('term');
    expect(term).toBe(`${name} LIL PEEP`);
  });

  it('502s only when every provider fails', async () => {
    stubFetch(() => json({}, 500));
    expect(await searchTracks({ songName: song(), artistName: 'x' })).toMatchObject({ status: 502 });
  });

  it('serves a repeated query from the cache', async () => {
    const name = song();
    stubFetch(() => json({ results: [], data: [] }));
    await searchTracks({ songName: name, artistName: 'A' });
    const calls = urls.length;
    await searchTracks({ songName: name.toUpperCase(), artistName: 'a' });
    expect(urls.length).toBe(calls);
  });
});

describe('lookupTrack', () => {
  it('404s rather than returning another artist\'s song', async () => {
    stubFetch((url) => url.includes('itunes') ? json({ results: [itunes.results[0]] }) : json({ data: [] }));
    expect(await lookupTrack(song(), 'Lil Peep')).toMatchObject({ status: 404 });
  });
});
