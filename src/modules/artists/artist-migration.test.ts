import { describe, it, expect } from 'vitest';
import { planArtists } from './artist-migration.js';

const row = (songArtist: string, songName = 'Song', title = '', artists?: unknown[]) =>
  ({ title, metadata: { songArtist, songName, artists } });
const credits = (p: ReturnType<typeof planArtists>) => p.after?.artists.map((a) => `${a.role}:${a.name}`);

describe('planArtists (migration fixtures)', () => {
  it('moves a feat. segment from the artist string into artists', () => {
    const p = planArtists(row('Drake feat. Rihanna'));
    expect(p.status).toBe('apply');
    expect(credits(p)).toEqual(['primary:Drake', 'featured:Rihanna']);
    expect(p.after?.songArtist).toBe('Drake feat. Rihanna');
    expect(p.after?.slug).toBe('drake-feat-rihanna-song');
  });

  it('moves a feat. segment out of the song name and the title, and only then edits them', () => {
    const p = planArtists(row('Drake', 'Song (feat. Rihanna)', 'Song feat. Kanye'));
    expect(p.status).toBe('apply');
    expect(credits(p)).toEqual(['primary:Drake', 'featured:Rihanna', 'featured:Kanye']);
    expect(p.after?.songName).toBe('Song');
    expect(p.after?.title).toBe('Song');
  });

  it('leaves titles alone when there is no feat. segment', () => {
    const p = planArtists(row('Drake', 'Plain Song', 'Plain Title'));
    expect(p.after?.songName).toBe('Plain Song');
    expect(p.after?.title).toBe('Plain Title');
    expect(credits(p)).toEqual(['primary:Drake']);
  });

  it('never rewrites a title to an empty string', () => {
    const p = planArtists(row('Drake', 'Song', '(feat. Rihanna)'));
    expect(p.after?.title).toBe('(feat. Rihanna)');
    expect(credits(p)).toContain('featured:Rihanna');
  });

  it('flags & / and / x splits as ambiguous and skips them by default', () => {
    for (const a of ['Simon & Garfunkel', 'A and B', 'A x B']) {
      const p = planArtists(row(a));
      expect(p.status, a).toBe('ambiguous');
      expect(p.after).toBeUndefined();
    }
  });

  it('applies ambiguous rows only when told to, splitting them', () => {
    const p = planArtists(row('Simon & Garfunkel'), true);
    expect(p.status).toBe('apply');
    expect(credits(p)).toEqual(['primary:Simon', 'primary:Garfunkel']);
  });

  it('flags a bare "ft" as ambiguous', () => {
    expect(planArtists(row('Drake ft Rihanna')).status).toBe('ambiguous');
  });

  it('never applies malformed rows, even with includeAmbiguous', () => {
    for (const r of [row('Drake feat.'), row('Drake', 'Song (feat. A'), row('Drake', 'Song (feat. )')]) {
      const p = planArtists(r, true);
      expect(p.status).toBe('invalid');
      expect(p.after).toBeUndefined();
    }
  });

  it('rejects rows with more names than allowed', () => {
    const many = Array.from({ length: 11 }, (_, i) => `N${i}`).join(', ');
    expect(planArtists(row(many)).status).toBe('invalid');
  });

  it('is a noop for rows that already have artists or no artist text (idempotent re-run)', () => {
    expect(planArtists(row('Drake feat. Rihanna', 'Song', '', [{ name: 'Drake', role: 'primary', order: 0 }])).status).toBe('noop');
    expect(planArtists(row('')).status).toBe('noop');
  });

  it('reports plain commas as unambiguous multi-primary', () => {
    const p = planArtists(row('A, B, C'));
    expect(p.status).toBe('apply');
    expect(p.after?.songArtist).toBe('A, B & C');
  });
});
