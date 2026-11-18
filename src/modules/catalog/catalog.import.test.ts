import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import Project from '../projects/project.model.js';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import CatalogAlbumDismissal from './catalog-album-dismissal.model.js';
import { importAlbumsFromSongs } from './catalog.import.service.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([CatalogArtist.init(), CatalogAlbum.init(), CatalogAlbumDismissal.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}), CatalogAlbumDismissal.deleteMany({}), Project.collection.deleteMany({}),
  ]);
});

const admin = new mongoose.Types.ObjectId();
let seq = 0;
const seedArtist = () =>
  CatalogArtist.create({ name: 'Björk', nameKey: 'björk', slug: 'bjork', status: 'approved', source: 'admin', submittedBy: admin });
const seedSong = (album: string) =>
  Project.collection.insertOne({
    publicId: `i${++seq}`, userId: new mongoose.Types.ObjectId(), title: 't', kind: 'song', public: true, ownerListed: true,
    metadata: { artists: [{ name: 'Björk', role: 'primary' }], songAlbum: album, songYear: '' },
  });

describe('importAlbumsFromSongs', () => {
  it('creates approved albums for album names on public songs', async () => {
    const artist = await seedArtist();
    await seedSong('Homogenic');
    await seedSong('Post');
    expect(await importAlbumsFromSongs(artist, String(admin))).toBe(2);
    const titles = (await CatalogAlbum.find({ artistId: artist._id, status: 'approved' }).lean()).map((a) => a.title).sort();
    expect(titles).toEqual(['Homogenic', 'Post']);
  });

  it('skips titles an admin dismissed in Detect albums', async () => {
    const artist = await seedArtist();
    await seedSong('Homogenic');
    await seedSong('Greatest Hits Bootleg');
    await CatalogAlbumDismissal.create({ artistId: artist._id, titleKey: 'greatest hits bootleg', dismissedBy: admin });

    expect(await importAlbumsFromSongs(artist, String(admin))).toBe(1);
    const titles = (await CatalogAlbum.find({ artistId: artist._id }).lean()).map((a) => a.title);
    expect(titles).toEqual(['Homogenic']);
  });

  it('matches a dismissal whose song spelling differs only in whitespace (same key as Detect albums)', async () => {
    const artist = await seedArtist();
    await seedSong('  Greatest   Hits ');
    await CatalogAlbumDismissal.create({ artistId: artist._id, titleKey: 'greatest hits', dismissedBy: admin });

    expect(await importAlbumsFromSongs(artist, String(admin))).toBe(0);
  });

  it('stores a squashed, tag-free title', async () => {
    const artist = await seedArtist();
    await seedSong('<b>Vespertine</b>   Live');

    expect(await importAlbumsFromSongs(artist, String(admin))).toBe(1);
    const [album] = await CatalogAlbum.find({ artistId: artist._id }).lean();
    expect(album.title).toBe('Vespertine Live');
  });
});
