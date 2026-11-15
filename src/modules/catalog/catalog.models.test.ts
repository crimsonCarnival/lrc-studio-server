import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';

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

const by = new mongoose.Types.ObjectId();

describe('catalog models', () => {
  it('applies defaults', async () => {
    const a = await CatalogArtist.create({ name: 'X', nameKey: 'x', status: 'pending', source: 'community', submittedBy: by });
    expect(a).toMatchObject({ slug: null, disambiguation: '', imageUrl: null, bio: '', reviewedBy: null, reviewNote: '', reviewedAt: null, creditAwarded: false });
  });

  it('enforces unique slug among artists that have one', async () => {
    await CatalogArtist.create({ name: 'A', nameKey: 'a', slug: 's', status: 'approved', source: 'admin', submittedBy: by });
    await expect(
      CatalogArtist.create({ name: 'B', nameKey: 'b', slug: 's', status: 'approved', source: 'admin', submittedBy: by })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects an invalid status', async () => {
    await expect(
      CatalogArtist.create({ name: 'A', nameKey: 'a', status: 'bogus', source: 'admin', submittedBy: by })
    ).rejects.toThrow();
  });

  it('album defaults and per-artist uniqueness', async () => {
    const artistId = new mongoose.Types.ObjectId();
    const base = { artistId, title: 'T', titleKey: 't', status: 'approved', source: 'admin', submittedBy: by };
    const a = await CatalogAlbum.create({ ...base, slug: 't' });
    expect(a).toMatchObject({ year: null, coverUrl: null, creditAwarded: false });
    await expect(CatalogAlbum.create({ ...base, slug: 't' })).rejects.toMatchObject({ code: 11000 });
    await expect(CatalogAlbum.create({ ...base, artistId: new mongoose.Types.ObjectId(), slug: 't' })).resolves.toBeTruthy();
  });
});
