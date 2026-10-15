import { describe, it, expect } from 'vitest';
import { artistResolvers } from './artist.resolvers.js';

describe('parseArtists query', () => {
  it('returns credits, cleaned title, flags and the display string', () => {
    const r = artistResolvers.Query.parseArtists({}, { artist: 'Drake ft. A, B', title: 'Song (feat. C)' });
    expect(r.display).toBe('Drake feat. A, B & C');
    expect(r.title).toBe('Song');
    expect(r.artists.map((a) => a.role)).toEqual(['primary', 'featured', 'featured', 'featured']);
  });

  it('caps the input it will parse', () => {
    const r = artistResolvers.Query.parseArtists({}, { artist: `${'a, '.repeat(2000)}`, title: null });
    expect(r.artists.length).toBeLessThanOrEqual(1000);
  });
});

describe('myArtistSuggestions authorization', () => {
  it('requires an authenticated user', async () => {
    await expect(
      artistResolvers.Query.myArtistSuggestions({}, { prefix: 'dr' }, { userId: null } as never),
    ).rejects.toMatchObject({ status: 401 });
  });
});
