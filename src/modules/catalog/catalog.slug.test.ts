import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { assignArtistSlug, assignAlbumSlug } from './catalog.slug.js';
import { artistKey } from '../artists/artist.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([CatalogArtist.init(), CatalogAlbum.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({})]);
});

const submitter = new mongoose.Types.ObjectId();
const mkArtist = (name: string) =>
  CatalogArtist.create({ name, nameKey: artistKey(name), status: 'approved', source: 'community', submittedBy: submitter });
const mkAlbum = (artistId: mongoose.Types.ObjectId, title: string) =>
  CatalogAlbum.create({ artistId, title, titleKey: artistKey(title.trim()), status: 'approved', source: 'community', submittedBy: submitter });

describe('assignArtistSlug', () => {
  it('slugs a plain name', async () => {
    const a = await mkArtist('Ghostemane');
    expect(await assignArtistSlug(a._id, a.name)).toBe('ghostemane');
    expect((await CatalogArtist.findById(a._id))?.slug).toBe('ghostemane');
  });

  it('appends -2 on clash, -3 on the next', async () => {
    const [a, b, c] = [await mkArtist('Ghostemane'), await mkArtist('Ghostemane'), await mkArtist('Ghostemane')];
    expect(await assignArtistSlug(a._id, a.name)).toBe('ghostemane');
    expect(await assignArtistSlug(b._id, b.name)).toBe('ghostemane-2');
    expect(await assignArtistSlug(c._id, c.name)).toBe('ghostemane-3');
  });

  it('falls back to artist-<id suffix> when the name has no letters or digits', async () => {
    const a = await mkArtist('!!!');
    expect(await assignArtistSlug(a._id, a.name)).toBe(`artist-${a._id.toString().slice(-6)}`);
  });

  it('keeps non-Latin letters', async () => {
    const a = await mkArtist('星野源');
    const slug = await assignArtistSlug(a._id, a.name);
    expect(slug).toBe('星野源');
  });

  it('never changes an existing slug', async () => {
    const a = await mkArtist('Ghostemane');
    const first = await assignArtistSlug(a._id, a.name);
    await CatalogArtist.updateOne({ _id: a._id }, { $set: { name: 'Renamed' } });
    expect(await assignArtistSlug(a._id, 'Renamed')).toBe(first);
    expect((await CatalogArtist.findById(a._id))?.slug).toBe(first);
  });

  it('concurrent assigns on one entry both return the same stored slug', async () => {
    const a = await mkArtist('Ghostemane');
    const [x, y] = await Promise.all([assignArtistSlug(a._id, a.name), assignArtistSlug(a._id, a.name)]);
    expect(x).toBe(y);
    expect((await CatalogArtist.findById(a._id))?.slug).toBe(x);
  });

  it('assigning a slug for a missing document throws catalog_entry_not_found', async () => {
    await expect(assignArtistSlug(new mongoose.Types.ObjectId(), 'Nobody')).rejects.toThrow('catalog_entry_not_found');
  });

  it('two pending entries reserve nothing', async () => {
    const a = await CatalogArtist.create({ name: 'Dup', nameKey: 'dup', status: 'pending', source: 'community', submittedBy: submitter });
    const b = await CatalogArtist.create({ name: 'Dup', nameKey: 'dup', status: 'pending', source: 'community', submittedBy: submitter });
    expect(a.slug).toBeNull();
    expect(b.slug).toBeNull();
  });
});

describe('assignAlbumSlug', () => {
  it('album slugs are unique per artist, not globally', async () => {
    const a1 = await mkArtist('One');
    const a2 = await mkArtist('Two');
    const x = await mkAlbum(a1._id, 'Greatest Hits');
    const y = await mkAlbum(a1._id, 'Greatest Hits');
    const z = await mkAlbum(a2._id, 'Greatest Hits');
    expect(await assignAlbumSlug(x._id, a1._id, x.title)).toBe('greatest-hits');
    expect(await assignAlbumSlug(y._id, a1._id, y.title)).toBe('greatest-hits-2');
    expect(await assignAlbumSlug(z._id, a2._id, z.title)).toBe('greatest-hits');
  });

  it('falls back to album-<id suffix> for symbol-only titles', async () => {
    const a = await mkArtist('One');
    const x = await mkAlbum(a._id, '???');
    expect(await assignAlbumSlug(x._id, a._id, x.title)).toBe(`album-${x._id.toString().slice(-6)}`);
  });
});
