import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import CatalogArtist from '../../modules/catalog/catalog-artist.model.js';
import { artistKey } from '../../modules/artists/artist.service.js';
import { loaders } from '../loaders.js';

type Loader = (queries: Array<{ obj: Record<string, unknown> }>, context: unknown) => Promise<unknown[]>;

/** Runs the ArtistCredit.catalogSlug loader the way Mercurius would, for a list of credits. */
function resolve(names: string[]): Promise<unknown[]> {
  const entry = (loaders as unknown as Record<string, Record<string, { loader: Loader }>>).ArtistCredit.catalogSlug;
  return entry.loader(names.map((name) => ({ obj: { name } })), {});
}

const owner = new mongoose.Types.ObjectId();
const make = (name: string, status: string, slug: string | null) =>
  CatalogArtist.create({ name, nameKey: artistKey(name), slug, status, source: 'community', submittedBy: owner });

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
  await CatalogArtist.deleteMany({});
});
afterEach(() => vi.restoreAllMocks());

describe('ArtistCredit.catalogSlug', () => {
  it('returns the slug of the single approved artist with the same name key', async () => {
    await make('Björk', 'approved', 'bjork');
    expect(await resolve(['BJÖRK', 'Bjo\u0308rk'])).toEqual(['bjork', 'bjork']);
  });

  it('null when no approved artist matches', async () => {
    await make('Björk', 'approved', 'bjork');
    expect(await resolve(['Nobody'])).toEqual([null]);
  });

  it('null for a pending or rejected match', async () => {
    await make('Pending One', 'pending', null);
    await make('Rejected One', 'rejected', null);
    expect(await resolve(['Pending One', 'Rejected One'])).toEqual([null, null]);
  });

  it('null when two approved homonyms share the key', async () => {
    await make('Twin', 'approved', 'twin');
    await make('Twin', 'approved', 'twin-2');
    await make('Solo', 'approved', 'solo');
    expect(await resolve(['Twin', 'Solo'])).toEqual([null, 'solo']);
  });

  it('batches: one CatalogArtist query for many credits', async () => {
    await make('A', 'approved', 'a');
    await make('B', 'approved', 'b');
    const spy = vi.spyOn(CatalogArtist, 'find');
    expect(await resolve(['A', 'B', 'A', 'C'])).toEqual(['a', 'b', 'a', null]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
