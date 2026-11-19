import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../genius/lrclib.service.js', () => ({ searchLrclib: vi.fn() }));
vi.mock('../genius/genius.client.js', () => ({ searchSong: vi.fn() }));
vi.mock('./groq-chat.client.js', async (orig) => ({
  ...(await orig<typeof import('./groq-chat.client.js')>()),
  chatJson: vi.fn(),
}));

import Artist from '../artists/artist.model.js';
import Project from '../projects/project.model.js';
import CatalogArtist from '../catalog/catalog-artist.model.js';
import CatalogAlbum from '../catalog/catalog-album.model.js';
import { searchLrclib } from '../genius/lrclib.service.js';
import { searchSong } from '../genius/genius.client.js';
import { chatJson, AssistError } from './groq-chat.client.js';
import { checkNames } from './name-check.service.js';
import { matchKey, isNear, maxDistanceFor } from './name-check.candidates.js';

const lrclib = vi.mocked(searchLrclib);
const genius = vi.mocked(searchSong);
const chat = vi.mocked(chatJson);

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const uid = new mongoose.Types.ObjectId();
const other = new mongoose.Types.ObjectId();
const user = uid.toString();
const own = (name: string, userId = uid) => Artist.create({ userId, name, nameLower: name.normalize('NFC').toLowerCase() });
const hit = (artist: string, album: string | null = null) =>
  ({ id: 'lrclib:1', title: 't', artist, album, provider: 'lrclib' }) as never;
const model = (...matches: Array<{ field: 'artist' | 'album'; candidate: string | null; confidence: number }>) =>
  chat.mockResolvedValueOnce({ matches } as never);

const catArtist = (name: string, status = 'approved') =>
  CatalogArtist.create({ name, nameKey: name.normalize('NFC').toLowerCase(), slug: status === 'approved' ? `${name.toLowerCase().replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 7)}` : null, status, source: 'admin', submittedBy: other });
const catAlbum = (artistId: unknown, title: string, status = 'approved') =>
  CatalogAlbum.create({ artistId, title, titleKey: title.toLowerCase(), slug: null, status, source: 'admin', submittedBy: other });
const ownSong = (album: string, artist = 'Radiohead', userId = uid) =>
  Project.collection.insertOne({ publicId: `n${Math.random()}`, userId, title: 't', kind: 'song', metadata: { artists: [{ name: artist, role: 'primary' }], songAlbum: album } });

beforeEach(async () => {
  await Promise.all([Artist.deleteMany({}), CatalogArtist.deleteMany({}), CatalogAlbum.deleteMany({}), Project.collection.deleteMany({})]);
  vi.clearAllMocks();
  lrclib.mockResolvedValue([]);
  genius.mockResolvedValue(null);
});

describe('matchKey', () => {
  it('removes spaces and case only', () => {
    expect(matchKey('$uicide Boy$')).toBe('$uicideboy$');
  });
});

describe('checkNames', () => {
  it('no candidates → [] and no model call', async () => {
    expect(await checkNames(user, { title: 'x', artist: 'Nobody' })).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('"radio head" with own artist "Radiohead" → deterministic suggestion, confidence 1, no model call', async () => {
    await own('Radiohead');
    expect(await checkNames(user, { title: 'x', artist: 'radio head' })).toEqual([
      { field: 'artist', suggestion: 'Radiohead', confidence: 1 },
    ]);
    expect(chat).not.toHaveBeenCalled();
  });

  it.each(['$uicideboy$', 'FLOW', '星野源'])('"%s" exactly in candidates → [] and no model call', async (name) => {
    await own(name);
    expect(await checkNames(user, { title: 'x', artist: name })).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('"Taylor Swi" → model picks "Taylor Swift" → suggestion returned', async () => {
    await own('Taylor Swift');
    model({ field: 'artist', candidate: 'Taylor Swift', confidence: 0.9 });
    expect(await checkNames(user, { title: 'x', artist: 'Taylor Swi' })).toEqual([
      { field: 'artist', suggestion: 'Taylor Swift', confidence: 0.9 },
    ]);
  });

  it('a model answer that is not a candidate is dropped', async () => {
    await own('Taylor Swift');
    model({ field: 'artist', candidate: 'Taylor Lautner', confidence: 0.9 });
    expect(await checkNames(user, { title: 'x', artist: 'Taylor Swi' })).toEqual([]);
  });

  it('an answer equal to the typed value is dropped', async () => {
    await own('Taylor Swift');
    model({ field: 'artist', candidate: 'Taylor Swi', confidence: 0.9 });
    expect(await checkNames(user, { title: 'x', artist: 'Taylor Swi' })).toEqual([]);
  });

  it('confidence 0.5 is dropped', async () => {
    await own('Taylor Swift');
    model({ field: 'artist', candidate: 'Taylor Swift', confidence: 0.5 });
    expect(await checkNames(user, { title: 'x', artist: 'Taylor Swi' })).toEqual([]);
  });

  it("another user's artists are never candidates", async () => {
    await own('Radiohead', other);
    expect(await checkNames(user, { title: 'x', artist: 'radio head' })).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('LRCLIB throwing and Genius returning null still use own artists', async () => {
    await own('Radiohead');
    lrclib.mockRejectedValue(new Error('down'));
    genius.mockResolvedValue(null);
    expect(await checkNames(user, { title: 'x', artist: 'radio head' })).toEqual([
      { field: 'artist', suggestion: 'Radiohead', confidence: 1 },
    ]);
  });

  it('a provider name differing only in case never restyles the typed value', async () => {
    lrclib.mockResolvedValue([hit('A', 'OK Computer')]);
    expect(await checkNames(user, { title: 'x', album: 'ok computer' })).toEqual([]);
    genius.mockResolvedValue([{ primary_artist: { name: 'Deadmau5' } }] as never);
    expect(await checkNames(user, { title: 'x', artist: 'deadmau5' })).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('album field still offers LRCLIB album names to the model', async () => {
    lrclib.mockResolvedValue([hit('A', 'OK Computer')]);
    model({ field: 'album', candidate: 'OK Computer', confidence: 0.8 });
    expect(await checkNames(user, { title: 'x', album: 'OK Compter' })).toEqual([
      { field: 'album', suggestion: 'OK Computer', confidence: 0.8 },
    ]);
  });

  it('chatJson throwing AssistError propagates', async () => {
    await own('Taylor Swift');
    chat.mockRejectedValueOnce(new AssistError('assist_upstream'));
    await expect(checkNames(user, { title: 'x', artist: 'Taylor Swi' })).rejects.toMatchObject({ code: 'assist_upstream' });
  });
});

describe('similarity', () => {
  it('scales the allowed distance with length', () => {
    expect(maxDistanceFor('iu')).toBe(1);
    expect(maxDistanceFor('taylorswi')).toBe(2);
    expect(maxDistanceFor('thisisaverylongname')).toBe(3);
  });

  it('keeps short names from matching every short name', () => {
    expect(isNear('Ado', 'Adele')).toBe(false);
    expect(isNear('IU', 'Ice')).toBe(false);
    expect(isNear('Radiohed', 'Radiohead')).toBe(true);
    expect(isNear('Tay', 'Taylor Swift')).toBe(true);
  });
});

describe('checkNames with the catalog', () => {
  it('approved catalog artists are candidates and may fix casing', async () => {
    await catArtist('MGMT');
    expect(await checkNames(user, { title: 'x', artist: 'mgmt' })).toEqual([{ field: 'artist', suggestion: 'MGMT', confidence: 1 }]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('pending and rejected catalog artists are not candidates', async () => {
    await catArtist('MGMT', 'pending');
    await catArtist('Mgmt', 'rejected');
    expect(await checkNames(user, { title: 'x', artist: 'mgmt' })).toEqual([]);
  });

  it('the catalog survives the candidate cap ahead of providers', async () => {
    await catArtist('Radiohead');
    lrclib.mockResolvedValue(Array.from({ length: 3 }, (_, i) => hit(`Radiohed ${i}`)));
    genius.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ primary_artist: { name: `Radiohea ${i}` } })) as never);
    model({ field: 'artist', candidate: 'Radiohead', confidence: 0.9 });
    await checkNames(user, { title: 'x', artist: 'Radiohed' });
    const payload = JSON.parse(String((chat.mock.calls[0][1] as Array<{ content: string }>)[1].content));
    expect(payload.fields[0].candidates[0]).toBe('Radiohead');
  });

  it("album candidates come from the named catalog artist's approved albums", async () => {
    const a = await catArtist('Radiohead');
    const b = await catArtist('Björk');
    await catAlbum(a._id, 'OK Computer');
    await catAlbum(a._id, 'Kid B', 'rejected');
    await catAlbum(b._id, 'Ok Computer');
    expect(await checkNames(user, { title: 'x', artist: 'radiohead', album: 'ok computer', field: 'album' })).toEqual([
      { field: 'album', suggestion: 'OK Computer', confidence: 1 },
    ]);
    expect(await checkNames(user, { title: 'x', artist: 'Radiohead', album: 'kid b', field: 'album' })).toEqual([]);
  });

  it('no catalog albums without an artist, or when the artist name has homonyms', async () => {
    const a = await catArtist('Nirvana');
    await catArtist('Nirvana');
    await catAlbum(a._id, 'Nevermind');
    expect(await checkNames(user, { title: 'x', album: 'nevermind' })).toEqual([]);
    expect(await checkNames(user, { title: 'x', artist: 'Nirvana', album: 'nevermind', field: 'album' })).toEqual([]);
  });

  it("the user's own album names for that artist are trusted candidates", async () => {
    await ownSong('In Rainbows');
    await ownSong('In Rainbows Live', 'Someone Else');
    await ownSong('In Rainbows Other', 'Radiohead', other);
    expect(await checkNames(user, { title: 'x', artist: 'Radiohead', album: 'in rainbows', field: 'album' })).toEqual([
      { field: 'album', suggestion: 'In Rainbows', confidence: 1 },
    ]);
  });

  it('field restricts the check; the other value is context only', async () => {
    await own('Radiohead');
    const a = await catArtist('Radiohead');
    await catAlbum(a._id, 'OK Computer');
    const out = await checkNames(user, { title: 'x', artist: 'radiohead', album: 'ok computer', field: 'album' });
    expect(out.map((s) => s.field)).toEqual(['album']);
  });
});
