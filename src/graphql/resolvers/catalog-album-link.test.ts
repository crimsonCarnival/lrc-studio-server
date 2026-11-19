import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import CatalogArtist from '../../modules/catalog/catalog-artist.model.js';
import CatalogAlbum from '../../modules/catalog/catalog-album.model.js';
import { artistKey } from '../../modules/artists/artist.service.js';
import { loaders } from '../loaders.js';

type Loader = (queries: Array<{ obj: Record<string, unknown> }>, context: unknown) => Promise<unknown[]>;
type Meta = { songAlbum?: string | null; artists?: Array<{ name: string; role: string }> };

/** Runs the ProjectMetadata.catalogAlbum loader the way Mercurius would, for a list of metadata objects. */
function resolve(metas: Meta[]): Promise<unknown[]> {
  const entry = (loaders as unknown as Record<string, Record<string, { loader: Loader }>>).ProjectMetadata.catalogAlbum;
  return entry.loader(metas.map((obj) => ({ obj })), {});
}

const owner = new mongoose.Types.ObjectId();
const artist = (name: string, slug: string | null, status = 'approved') =>
  CatalogArtist.create({ name, nameKey: artistKey(name), slug, status, source: 'admin', submittedBy: owner });
const album = (artistId: mongoose.Types.ObjectId, title: string, slug: string | null, status = 'approved') =>
  CatalogAlbum.create({ artistId, title, titleKey: title.toLowerCase(), slug, status, source: 'admin', submittedBy: owner });
const primary = (name: string) => ({ name, role: 'primary' });

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({})]);
});

describe('ProjectMetadata.catalogAlbum', () => {
  it('links a song to its approved album, matching the album page keys', async () => {
    const a = await artist('Robyn', 'robyn');
    await album(a._id, 'Honey', 'honey');
    expect(await resolve([
      { songAlbum: '  <b>honey</b> ', artists: [primary('ROBYN')] },
      { songAlbum: 'Honey', artists: [{ name: 'Other', role: 'primary' }, { name: 'Robyn', role: 'featured' }] },
      { songAlbum: '', artists: [primary('Robyn')] },
      { songAlbum: 'Body Talk', artists: [primary('Robyn')] },
    ])).toEqual([{ artistSlug: 'robyn', albumSlug: 'honey' }, null, null, null]);
  });

  it('uses the first primary artist that has a single catalog entry', async () => {
    const a = await artist('Robyn', 'robyn');
    await album(a._id, 'Honey', 'honey');
    expect(await resolve([{ songAlbum: 'Honey', artists: [primary('Unknown'), primary('Robyn')] }]))
      .toEqual([{ artistSlug: 'robyn', albumSlug: 'honey' }]);
  });

  it('never links through homonyms or unapproved entries', async () => {
    const n1 = await artist('Nirvana', 'nirvana');
    await artist('Nirvana', 'nirvana-2');
    await album(n1._id, 'Nevermind', 'nevermind');
    const p = await artist('Pend', null, 'pending');
    await album(p._id, 'X', null, 'pending');
    const r = await artist('Rej', 'rej');
    await album(r._id, 'Gone', null, 'rejected');
    expect(await resolve([
      { songAlbum: 'Nevermind', artists: [primary('Nirvana')] },
      { songAlbum: 'X', artists: [primary('Pend')] },
      { songAlbum: 'Gone', artists: [primary('Rej')] },
    ])).toEqual([null, null, null]);
  });

  it('answers a batch with no catalog artists without querying albums', async () => {
    expect(await resolve([{ songAlbum: 'A', artists: [primary('Nobody')] }, {}])).toEqual([null, null]);
  });
});
