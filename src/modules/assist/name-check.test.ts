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
import { searchLrclib } from '../genius/lrclib.service.js';
import { searchSong } from '../genius/genius.client.js';
import { chatJson, AssistError } from './groq-chat.client.js';
import { checkNames } from './name-check.service.js';
import { matchKey } from './name-check.candidates.js';

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

beforeEach(async () => {
  await Artist.deleteMany({});
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

  it('album field uses LRCLIB album names', async () => {
    lrclib.mockResolvedValue([hit('A', 'OK Computer')]);
    expect(await checkNames(user, { title: 'x', album: 'ok computer' })).toEqual([
      { field: 'album', suggestion: 'OK Computer', confidence: 1 },
    ]);
  });

  it('chatJson throwing AssistError propagates', async () => {
    await own('Taylor Swift');
    chat.mockRejectedValueOnce(new AssistError('assist_upstream'));
    await expect(checkNames(user, { title: 'x', artist: 'Taylor Swi' })).rejects.toMatchObject({ code: 'assist_upstream' });
  });
});
