import { describe, it, expect } from 'vitest';
import {
  hasProjectIdentity, cleanTitle, cleanIdentityMetadata, fallbackTitle,
  PROJECT_TITLE_MAX, PROJECT_SONG_NAME_MAX,
} from './project-identity.js';
import { resolveMetadataArtists } from './project-identity.js';
import { planSlug } from './project-slug.migration.js';

// applyProjectIdentity lives in the CRUD service, which pulls in the whole app
// graph; it is imported lazily so a missing env in this unit file cannot break it.
async function applyProjectIdentity() {
  return (await import('./projects.crud.service.js')).applyProjectIdentity;
}

describe('hasProjectIdentity (the create rule)', () => {
  it('rejects nothing-at-all, whitespace and punctuation-only', () => {
    expect(hasProjectIdentity(undefined, undefined)).toBe(false);
    expect(hasProjectIdentity('', {})).toBe(false);
    expect(hasProjectIdentity('  ', {})).toBe(false);
    expect(hasProjectIdentity('!!!', {})).toBe(false);
  });

  it('accepts a title, a song name or an artist', () => {
    expect(hasProjectIdentity('x', {})).toBe(true);
    expect(hasProjectIdentity('', { songArtist: 'Radiohead' })).toBe(true);
    expect(hasProjectIdentity('', { songName: 'Creep' })).toBe(true);
  });
});

describe('server-side trimming and caps', () => {
  it('trims, strips HTML and caps the title', () => {
    expect(cleanTitle('  <b>Hi</b>  ')).toBe('Hi');
    expect(cleanTitle('a'.repeat(500))).toHaveLength(PROJECT_TITLE_MAX);
    expect(cleanTitle(undefined)).toBe('');
  });

  it('caps songName and leaves the rest alone', () => {
    const m = cleanIdentityMetadata({
      songName: 'n'.repeat(900), genre: 'Rock', tags: ['t'],
    });
    expect(String(m.songName)).toHaveLength(PROJECT_SONG_NAME_MAX);
    expect(m.genre).toBe('Rock');
    expect(m.tags).toEqual(['t']);
  });

  it('does not invent songName / songArtist keys that were not sent', () => {
    expect(cleanIdentityMetadata({ description: 'd' })).toEqual({ description: 'd' });
  });
});

describe('applyProjectIdentity (the update rule)', () => {
  it('recomputes the slug in the same update when song or artist changes', async () => {
    const apply = await applyProjectIdentity();
    const update: Record<string, unknown> = { metadata: { songName: 'Creep', artists: [{ name: 'Radiohead', role: 'primary' }] } };
    expect(apply({ title: 'old', metadata: { songName: 'Old' } }, update)).toBeNull();
    expect(update.slug).toBe('radiohead-creep');
  });

  it('recomputes the slug from a new title when there is no song or artist', async () => {
    const apply = await applyProjectIdentity();
    const update: Record<string, unknown> = { title: '  Fresh Title ' };
    expect(apply({ title: 'old', metadata: {} }, update)).toBeNull();
    expect(update.title).toBe('Fresh Title');
    expect(update.slug).toBe('fresh-title');
  });

  it('rejects blanking the last of title / song / artist', async () => {
    const apply = await applyProjectIdentity();
    const err = apply({ title: 'x', metadata: {} }, { title: '   ' });
    expect(err?.code).toBe('project_identity_required');
    expect(err?.status).toBe(422);
    expect(apply(
      { title: '', metadata: { songArtist: 'A', artists: [{ name: 'A', role: 'primary', order: 0 }] } },
      { metadata: { artists: [] } },
    )?.code).toBe('project_identity_required');
  });

  it('allows blanking one field while another still names the project', async () => {
    const apply = await applyProjectIdentity();
    const update: Record<string, unknown> = { title: '' };
    expect(apply({ title: 'x', metadata: { songName: 'Creep' } }, update)).toBeNull();
    expect(update.slug).toBe('creep');
  });

  it('never blocks an unrelated edit to a legacy row with no identity', async () => {
    const apply = await applyProjectIdentity();
    const update: Record<string, unknown> = { metadata: { description: 'just a note' } };
    expect(apply({ title: '', metadata: {} }, update)).toBeNull();
    expect(update.slug).toBe('');
    const untouched: Record<string, unknown> = { public: true };
    expect(apply({ title: '', metadata: {} }, untouched)).toBeNull();
    expect('slug' in untouched).toBe(false);
  });
});

describe('migration fixtures (planSlug)', () => {
  it('derives accents, CJK and kana the same way the app does', () => {
    expect(planSlug({ title: '', metadata: { songArtist: 'Beyoncé', songName: 'Halo' } })).toEqual({ slug: 'beyonce-halo' });
    expect(planSlug({ title: '', metadata: { songArtist: '米津玄師', songName: 'ありがとう' } })).toEqual({ slug: '米津玄師-ありがとう' });
    expect(planSlug({ title: 'が', metadata: {} })).toEqual({ slug: 'が' });
  });

  it('falls back to the title when metadata is empty', () => {
    expect(planSlug({ title: 'Canción del Mariachi', metadata: { songName: '', songArtist: '' } })).toEqual({ slug: 'cancion-del-mariachi' });
  });

  it('names an empty row after its upload, then its file name, then "untitled"', () => {
    expect(planSlug({ title: '', metadata: {} }, { title: 'Upload Title', fileName: 'f.mp3' }))
      .toEqual({ slug: 'upload-title', title: 'Upload Title' });
    expect(planSlug({ title: '', metadata: {} }, { title: '', fileName: 'my song.mp3' }))
      .toEqual({ slug: 'my-song-mp3', title: 'my song.mp3' });
    expect(planSlug({ title: '', metadata: {} }, null)).toEqual({ slug: 'untitled', title: 'untitled' });
    expect(planSlug({ title: '!!!', metadata: {} }, { title: '??', fileName: '' })).toEqual({ slug: 'untitled', title: 'untitled' });
  });

  it('fallbackTitle never returns something that slugs to nothing', () => {
    expect(fallbackTitle({ title: '***', fileName: '' })).toBe('untitled');
  });
});

describe('resolveMetadataArtists', () => {
  const credit = (name: string, role: 'primary' | 'featured', order: number) => ({ name, role, order });
  const run = (meta: Record<string, unknown>, existing: Record<string, unknown> | null = null) => {
    const r = resolveMetadataArtists(meta, existing);
    if ('failure' in r) throw new Error(`unexpected failure ${r.failure.code}`);
    return r.metadata;
  };

  it('derives songArtist from artists and ignores a songArtist that was sent', () => {
    const m = run({ songArtist: 'ignored', artists: [{ name: ' Drake ', role: 'primary' }, { name: 'Rihanna', role: 'featured' }] });
    expect(m.songArtist).toBe('Drake feat. Rihanna');
    expect(m.artists).toEqual([credit('Drake', 'primary', 0), credit('Rihanna', 'featured', 1)]);
  });

  it('drops a client-supplied artistId and strips HTML from names', () => {
    const m = run({ artists: [{ name: '<b>Drake</b>', role: 'primary', artistId: '507f1f77bcf86cd799439011' }] });
    expect(m.artists).toEqual([credit('Drake', 'primary', 0)]);
  });

  it('reports validation failures with a code', () => {
    const r = resolveMetadataArtists({ artists: [{ name: 'A', role: 'featured' }] }, null);
    expect('failure' in r && r.failure).toMatchObject({ code: 'artist_primary_required', status: 422 });
    const d = resolveMetadataArtists({ artists: [{ name: 'A', role: 'primary' }, { name: 'a', role: 'primary' }] }, null);
    expect('failure' in d && d.failure.code).toBe('artist_duplicate');
  });

  it('an empty list clears the artists and songArtist', () => {
    const m = run({ artists: [] }, { songArtist: 'A', artists: [credit('A', 'primary', 0)] });
    expect(m.artists).toEqual([]);
    expect(m.songArtist).toBe('');
  });

  it('keeps stored credits when an edit does not send artists', () => {
    const existing = { songArtist: 'A feat. B', artists: [credit('A', 'primary', 0), credit('B', 'featured', 1)] };
    const m = run({ description: 'd' }, existing);
    expect(m.artists).toEqual(existing.artists);
    expect(m.songArtist).toBe('A feat. B');
  });

  it('keeps a legacy songArtist on a row that never had artists', () => {
    expect(run({ description: 'd' }, { songArtist: 'Legacy Text' }).songArtist).toBe('Legacy Text');
    expect(run({ songArtist: 'sneaky' }, null).songArtist).toBeUndefined();
  });
});
