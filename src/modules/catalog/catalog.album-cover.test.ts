import { beforeEach, describe, expect, it, vi } from 'vitest';

const artistFind = vi.hoisted(() => ({ findById: vi.fn() }));
vi.mock('./catalog-artist.model.js', () => ({ default: { findById: (id: string) => ({ select: () => ({ lean: () => artistFind.findById(id) }) }) } }));
vi.mock('./catalog.admin.service.js', () => ({ assertManager: vi.fn() }));
vi.mock('./catalog.query.service.js', async (orig) => ({ ...(await orig<typeof import('./catalog.query.service.js')>()), listPublicSongsByArtist: vi.fn() }));
vi.mock('./catalog.genius.service.js', () => ({ storeRemoteImage: vi.fn() }));

import { assertManager } from './catalog.admin.service.js';
import { listPublicSongsByArtist } from './catalog.query.service.js';
import { storeRemoteImage } from './catalog.genius.service.js';
import { copyProjectCover, isOwnCloudinaryUrl, listProjectCoverProposals } from './catalog.album-cover.service.js';

const ADMIN = '64b000000000000000000001';
const ARTIST = '64b000000000000000000002';
const own = (n: string) => `https://res.cloudinary.com/democloud/image/upload/v1/lyrics-syncer/covers/${n}.jpg`;
const song = (publicId: string, over: Record<string, unknown> = {}) => ({
  publicId,
  title: `Song ${publicId}`,
  coverImage: own(publicId),
  metadata: { songAlbum: 'OK Computer', artists: [{ name: 'Radiohead', role: 'primary' }] },
  ...over,
});

beforeEach(() => {
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'democloud');
  vi.mocked(assertManager).mockReset().mockResolvedValue(null);
  artistFind.findById.mockReset().mockResolvedValue({ name: 'Radiohead', nameKey: 'radiohead' });
  vi.mocked(listPublicSongsByArtist).mockReset().mockResolvedValue([]);
  vi.mocked(storeRemoteImage).mockReset().mockResolvedValue('https://res.cloudinary.com/democloud/image/upload/v1/catalog/x.webp');
});

describe('isOwnCloudinaryUrl', () => {
  it('accepts only our cloud over https with no extras', () => {
    expect(isOwnCloudinaryUrl(own('a'))).toBe(true);
    for (const bad of [
      'http://res.cloudinary.com/democloud/image/upload/a.jpg',
      'https://res.cloudinary.com/othercloud/image/upload/a.jpg',
      'https://res.cloudinary.com.evil.test/democloud/image/upload/a.jpg',
      'https://res.cloudinary.com/democloud/image/upload/a.jpg?x=1',
      'https://u@res.cloudinary.com/democloud/image/upload/a.jpg',
      'https://res.cloudinary.com/democloud/video/upload/a.mp4',
      'https://i.scdn.co/image/abc', '', null, 5,
    ]) expect(isOwnCloudinaryUrl(bad)).toBe(false);
  });
});

describe('listProjectCoverProposals', () => {
  it('offers covers of primary-credited songs on the same album, deduped', async () => {
    vi.mocked(listPublicSongsByArtist).mockResolvedValue([
      song('p1'),
      song('p2', { coverImage: own('p1') }),
      song('p3', { metadata: { songAlbum: 'ok computer', artists: [{ name: 'Radiohead', role: 'primary' }] }, coverImage: own('p3') }),
      song('p4', { metadata: { songAlbum: 'Kid A', artists: [{ name: 'Radiohead', role: 'primary' }] } }),
      song('p5', { metadata: { songAlbum: 'OK Computer', artists: [{ name: 'Radiohead', role: 'featured' }] } }),
      song('p6', { coverImage: 'https://i.scdn.co/image/abc' }),
      song('p7', { coverImage: '' }),
    ] as never);
    expect(await listProjectCoverProposals(ADMIN, ARTIST, 'OK Computer')).toEqual([
      { publicId: 'p1', title: 'Song p1', coverUrl: own('p1') },
      { publicId: 'p3', title: 'Song p3', coverUrl: own('p3') },
    ]);
  });

  it('caps at 5, refuses non-managers and reports an unknown artist', async () => {
    vi.mocked(listPublicSongsByArtist).mockResolvedValue(Array.from({ length: 9 }, (_, i) => song(`s${i}`)) as never);
    expect(await listProjectCoverProposals(ADMIN, ARTIST, 'OK Computer')).toHaveLength(5);
    vi.mocked(assertManager).mockResolvedValueOnce({ error: 'x', status: 403, code: 'CATALOG_FORBIDDEN' });
    expect(await listProjectCoverProposals(ADMIN, ARTIST, 'x')).toMatchObject({ status: 403 });
    artistFind.findById.mockResolvedValue(null);
    expect(await listProjectCoverProposals(ADMIN, ARTIST, 'x')).toMatchObject({ status: 404, code: 'CATALOG_COVER_PROPOSAL_NOT_FOUND' });
    expect(await listProjectCoverProposals(ADMIN, 'not-an-id', 'x')).toMatchObject({ status: 404 });
  });
});

describe('copyProjectCover', () => {
  it('copies a proposed cover resolved server-side, nothing else', async () => {
    vi.mocked(listPublicSongsByArtist).mockResolvedValue([song('p1')] as never);
    expect(await copyProjectCover(ADMIN, ARTIST, 'OK Computer', 'p1')).toEqual({ imageUrl: 'https://res.cloudinary.com/democloud/image/upload/v1/catalog/x.webp' });
    expect(storeRemoteImage).toHaveBeenCalledWith(own('p1'), ADMIN);
  });

  it('404s a publicId that is not one of the proposals', async () => {
    vi.mocked(listPublicSongsByArtist).mockResolvedValue([song('p1'), song('other', { metadata: { songAlbum: 'Kid A', artists: [{ name: 'Radiohead', role: 'primary' }] } })] as never);
    expect(await copyProjectCover(ADMIN, ARTIST, 'OK Computer', 'other')).toMatchObject({ status: 404 });
    expect(await copyProjectCover(ADMIN, ARTIST, 'OK Computer', 'nope')).toMatchObject({ status: 404 });
    expect(storeRemoteImage).not.toHaveBeenCalled();
  });

  it('passes storage failures through', async () => {
    vi.mocked(listPublicSongsByArtist).mockResolvedValue([song('p1')] as never);
    vi.mocked(storeRemoteImage).mockResolvedValue({ error: 'x', status: 502, code: 'CATALOG_GENIUS_UPSTREAM' });
    expect(await copyProjectCover(ADMIN, ARTIST, 'OK Computer', 'p1')).toMatchObject({ status: 502 });
  });
});
