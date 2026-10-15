import { describe, it, expect } from 'vitest';
import { buildLrcExportMetadata, compileLRC, parseLrcMetaTags } from './lrc.js';

const credits = [
  { name: 'Drake', role: 'primary' },
  { name: 'Rihanna', role: 'featured' },
  { name: 'Kanye', role: 'featured' },
];

describe('buildLrcExportMetadata', () => {
  it('writes [ar:] from the credits and leaves [ti:] plain by default', () => {
    const r = buildLrcExportMetadata({ ti: 'Song', ar: 'ignored', artists: credits });
    expect(r).toEqual({ ok: true, metadata: { ti: 'Song', ar: 'Drake feat. Rihanna & Kanye' } });
  });

  it('appends featured artists to [ti:] only when asked', () => {
    const r = buildLrcExportMetadata({ ti: 'Song', artists: credits }, true);
    expect(r.ok && r.metadata.ti).toBe('Song (feat. Rihanna & Kanye)');
    const noFeat = buildLrcExportMetadata({ ti: 'Song', artists: [credits[0]] }, true);
    expect(noFeat.ok && noFeat.metadata.ti).toBe('Song');
  });

  it('passes a plain ar string through when no credits are sent', () => {
    expect(buildLrcExportMetadata({ ti: 'Song', ar: 'Legacy' })).toEqual({ ok: true, metadata: { ti: 'Song', ar: 'Legacy' } });
  });

  it('keeps a plain ar when credits are an empty list', () => {
    expect(buildLrcExportMetadata({ ar: 'Legacy', artists: [] })).toEqual({ ok: true, metadata: { ar: 'Legacy' } });
  });

  it('rejects invalid credits with a code', () => {
    expect(buildLrcExportMetadata({ artists: [{ name: 'A', role: 'featured' }] })).toMatchObject({ ok: false, code: 'artist_primary_required' });
  });

  it('ends up in the compiled LRC header', () => {
    const header = buildLrcExportMetadata({ ti: 'Song', artists: credits });
    if (!header.ok) throw new Error('unexpected');
    const out = compileLRC([{ text: 'hi', timestamp: 1, id: 'x' }], false, 'hundredths', header.metadata);
    expect(out.split('\n').slice(0, 2)).toEqual(['[ti:Song]', '[ar:Drake feat. Rihanna & Kanye]']);
  });
});

describe('parseLrcMetaTags', () => {
  it('reads known header tags, in any case, with CRLF', () => {
    const lrc = '[ti:Song (feat. B)]\r\n[AR: A ]\r\n[al:Album]\r\n[00:01.00]hello\r\n';
    expect(parseLrcMetaTags(lrc)).toEqual({ ti: 'Song (feat. B)', ar: 'A', al: 'Album' });
  });

  it('ignores timestamps, unknown tags and empty values', () => {
    expect(parseLrcMetaTags('[00:01.00]x\n[tool:me]\n[ar:]\n[length: 3:00]')).toEqual({});
  });
});
