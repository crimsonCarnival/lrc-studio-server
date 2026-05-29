import { describe, it, expect } from 'vitest';
import { youtubeThumbnail } from './cover-image.js';

describe('youtubeThumbnail', () => {
  it('builds an hqdefault URL from a watch URL', () => {
    expect(youtubeThumbnail('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });
  it('builds from a youtu.be short URL', () => {
    expect(youtubeThumbnail('https://youtu.be/dQw4w9WgXcQ'))
      .toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });
  it('accepts a bare 11-char id', () => {
    expect(youtubeThumbnail('dQw4w9WgXcQ'))
      .toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });
  it('returns null for unparseable input', () => {
    expect(youtubeThumbnail('not a url')).toBeNull();
    expect(youtubeThumbnail(null)).toBeNull();
  });
});
