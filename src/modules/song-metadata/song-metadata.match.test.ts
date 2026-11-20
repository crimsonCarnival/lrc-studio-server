import { describe, expect, it } from 'vitest';
import { baseTitle, bestMatch, normalize, rankCandidates, splitArtists, type TrackCandidate } from './song-metadata.match.js';

const track = (over: Partial<TrackCandidate>): TrackCandidate => ({
  provider: 'itunes', trackId: Math.random().toString(36).slice(2), name: '', artist: '', album: '', duration: 0,
  albumArt: null, releaseYear: null, totalTracks: null, trackNumber: null, previewUrl: null, explicit: false, genres: [],
  ...over,
});

describe('normalize / baseTitle / splitArtists', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalize('  LIL  PEEP ')).toBe('lil peep');
    expect(normalize('Beyoncé & JAY-Z')).toBe('beyonce and jay z');
  });
  it('drops feat., brackets and dash tails from titles', () => {
    expect(baseTitle('Castles (feat. SNIIMA BEATS)')).toBe('castles');
    expect(baseTitle('Castles - Remastered 2011')).toBe('castles');
    expect(baseTitle('Castles [Sped Up]')).toBe('castles');
  });
  it('splits joined credits but keeps "and" inside names', () => {
    expect(splitArtists('Lil Peep & Lil Tracy')).toEqual(['Lil Peep', 'Lil Tracy']);
    expect(splitArtists('A, B x C feat. D')).toEqual(['A', 'B', 'C', 'D']);
    expect(splitArtists('Florence and the Machine')).toEqual(['Florence and the Machine']);
  });
});

describe('rankCandidates', () => {
  // What the providers answered for "castles LIL PEEP": popularity first.
  const castles = [
    track({ name: 'Castles', artist: 'Tom MacDonald', provider: 'spotify' }),
    track({ name: 'Castles (feat. SNIIMA BEATS)', artist: 'Lil Peep' }),
    track({ name: 'castles', artist: 'Lil Peep, Lil Tracy', provider: 'deezer' }),
    track({ name: 'Castles (Sped Up)', artist: 'Lil Peep & Lil Tracy' }),
  ];

  it('never ranks another artist above the requested one, whatever the case typed', () => {
    const ranked = rankCandidates(castles, { songName: 'castles', artistName: 'LIL PEEP' });
    expect(ranked.at(-1)!.artist).toBe('Tom MacDonald');
    expect(ranked.at(-1)!.artistMatch).toBe(false);
    expect(ranked.slice(0, -1).every((r) => r.artistMatch)).toBe(true);
  });

  it('puts the version with the requested featured artist first', () => {
    const ranked = rankCandidates(castles, { songName: 'castles', artistName: 'Lil Peep', featuredArtists: ['Lil Tracy'] });
    expect(ranked[0]).toMatchObject({ name: 'castles', artist: 'Lil Peep, Lil Tracy', featuredMatch: true, titleMatch: true });
    // The sped-up edit is a different recording: below the original.
    const sped = ranked.findIndex((r) => r.name.includes('Sped'));
    expect(sped).toBeGreaterThan(0);
  });

  it('finds a featured artist credited only in the title', () => {
    const ranked = rankCandidates(
      [track({ name: 'castles', artist: 'Lil Peep' }), track({ name: 'castles (feat. Lil Tracy)', artist: 'Lil Peep' })],
      { songName: 'castles', artistName: 'Lil Peep', featuredArtists: ['Lil Tracy'] },
    );
    expect(ranked[0].name).toBe('castles (feat. Lil Tracy)');
  });

  it('matches squashed spellings of the artist', () => {
    const [top] = rankCandidates([track({ name: 'castles', artist: 'Lil Peep' })], { songName: 'castles', artistName: 'LILPEEP' });
    expect(top.artistMatch).toBe(true);
  });

  it('merges the same track from two providers, filling blanks', () => {
    const ranked = rankCandidates([
      track({ provider: 'spotify', name: 'castles', artist: 'Lil Peep, Lil Tracy', albumArt: 'https://a/1.jpg' }),
      track({ provider: 'deezer', name: 'Castles', artist: 'Lil Peep & Lil Tracy', previewUrl: 'https://p/1.mp3', releaseYear: '2016' }),
    ], { songName: 'castles', artistName: 'Lil Peep' });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ provider: 'spotify', albumArt: 'https://a/1.jpg', previewUrl: 'https://p/1.mp3', releaseYear: '2016' });
  });

  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => track({ name: `Song ${i}`, artist: `A${i}` }));
    expect(rankCandidates(many, { songName: 'song' }, 5)).toHaveLength(5);
  });
});

describe('bestMatch', () => {
  it('refuses a top result by another artist', () => {
    const ranked = rankCandidates([track({ name: 'Castles', artist: 'Tom MacDonald' })], { songName: 'castles', artistName: 'Lil Peep' });
    expect(bestMatch(ranked)).toBeNull();
  });
});
