import { describe, it, expect } from 'vitest';
import {
  hasProjectIdentity, cleanTitle, cleanIdentityMetadata, fallbackTitle,
  PROJECT_TITLE_MAX, PROJECT_SONG_ARTIST_MAX, PROJECT_SONG_NAME_MAX,
} from './project-identity.js';
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

  it('caps songName and songArtist and leaves the rest alone', () => {
    const m = cleanIdentityMetadata({
      songName: 'n'.repeat(900), songArtist: ` ${'a'.repeat(900)} `, genre: 'Rock', tags: ['t'],
    });
    expect(String(m.songName)).toHaveLength(PROJECT_SONG_NAME_MAX);
    expect(String(m.songArtist)).toHaveLength(PROJECT_SONG_ARTIST_MAX);
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
    const update: Record<string, unknown> = { metadata: { songName: 'Creep', songArtist: 'Radiohead' } };
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
    expect(apply({ title: '', metadata: { songArtist: 'A' } }, { metadata: { songArtist: '' } })?.code).toBe('project_identity_required');
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
