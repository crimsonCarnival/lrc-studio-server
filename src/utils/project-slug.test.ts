import { describe, it, expect } from 'vitest';
import { slugify, projectSlug, projectPath } from './project-slug.js';

// These vectors are shared with the web client's project-path tests; the two
// implementations must agree byte for byte.
describe('slugify', () => {
  it('folds Latin diacritics and drops apostrophes', () => {
    expect(slugify('Beyoncé — Don\'t Hurt Yourself!')).toBe('beyonce-dont-hurt-yourself');
    expect(slugify('Beyoncé — Don’t Hurt Yourself!')).toBe('beyonce-dont-hurt-yourself');
    expect(slugify('Canción del Mariachi')).toBe('cancion-del-mariachi');
  });

  it('keeps letters and digits of any script, including kana with dakuten', () => {
    expect(slugify('米津玄師 ありがとう')).toBe('米津玄師-ありがとう');
    expect(slugify('が')).toBe('が');
    expect(slugify('Кино Группа крови')).toBe('кино-группа-крови');
  });

  it('returns an empty string when nothing is left', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('caps at 60 characters without a trailing dash', () => {
    const s = slugify('word '.repeat(40));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
    expect(s.startsWith('word-word')).toBe(true);
  });

  it('never leaves half a surrogate pair at the cut', () => {
    const s = slugify('a'.repeat(59) + '😀' + '𠮷'.repeat(5)); // the emoji is not a letter; the astral CJK is
    expect(() => encodeURIComponent(s)).not.toThrow();
    const t = slugify('a'.repeat(59) + '𠮷𠮷');
    expect(() => encodeURIComponent(t)).not.toThrow();
  });
});

describe('projectSlug', () => {
  it('prefers artist + song name over the title', () => {
    expect(projectSlug({ title: 'ignored', metadata: { songArtist: 'Radiohead', songName: 'Creep' } })).toBe('radiohead-creep');
  });

  it('falls back to the title, then to empty', () => {
    expect(projectSlug({ title: 'My Mix', metadata: {} })).toBe('my-mix');
    expect(projectSlug({ title: '!!!', metadata: { songName: '', songArtist: '' } })).toBe('');
    expect(projectSlug({})).toBe('');
  });

  it('works with only an artist or only a song', () => {
    expect(projectSlug({ metadata: { songArtist: 'Radiohead' } })).toBe('radiohead');
    expect(projectSlug({ metadata: { songName: 'Creep' } })).toBe('creep');
  });

  it('uses the first of songArtists when songArtist is empty', () => {
    expect(projectSlug({ metadata: { songArtists: ['Björk', 'x'], songName: 'Army of Me' } })).toBe('bjork-army-of-me');
  });
});

describe('projectPath', () => {
  const base = { publicId: 'k3x9a2c7qm', metadata: { songArtist: 'Radiohead', songName: 'Creep' } };

  it('builds /:accountName/projects/:slug-:publicId', () => {
    expect(projectPath(base, '32blunts')).toBe('/32blunts/projects/radiohead-creep-k3x9a2c7qm');
  });

  it('prefers the stored slug', () => {
    expect(projectPath({ ...base, slug: 'stored' }, '32blunts')).toBe('/32blunts/projects/stored-k3x9a2c7qm');
  });

  it('is just the id when there is no slug', () => {
    expect(projectPath({ publicId: 'k3x9a2c7qm' }, '32blunts')).toBe('/32blunts/projects/k3x9a2c7qm');
  });

  it('falls back to the legacy URL without an owner', () => {
    expect(projectPath(base, null)).toBe('/project/k3x9a2c7qm');
  });

  it('percent-encodes non-ASCII slugs and account names', () => {
    expect(projectPath({ publicId: 'k3x9a2c7qm', metadata: { songName: 'ありがとう' } }, 'a.b'))
      .toBe(`/a.b/projects/${encodeURIComponent('ありがとう-k3x9a2c7qm')}`);
  });
});
