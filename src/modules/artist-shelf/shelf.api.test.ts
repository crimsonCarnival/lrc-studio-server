import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));
vi.mock('../auth/auth.service.js', () => ({ verifyRecaptcha: async () => true }));
vi.mock('../badges/badge.service.js', () => ({
  recomputeSyncStats: async () => undefined,
  scheduleSyncStatsRefresh: () => undefined,
  triggerBadgeCheck: async () => undefined,
  updateStreak: async () => undefined,
}));
vi.mock('../../jobs/leaderboard-ranking.job.js', () => ({ recomputeLeaderboardRanking: async () => undefined }));
vi.mock('../user-logs/logs.service.js', () => ({ logUserAction: () => undefined }));
vi.mock('../notifications/notifications.service.js', () => ({ upsertSocial: async () => undefined }));

import Artist from '../artists/artist.model.js';
import User from '../users/user.model.js';
import Project from '../projects/project.model.js';
import ProjectFork from '../projects/project-fork.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Block from '../blocks/block.model.js';
import Follow from '../users/follow.model.js';
import ShelfVisibility from './shelf-visibility.model.js';
import { createProject } from '../projects/projects.crud.service.js';
import { blockUser } from '../blocks/block.service.js';
import { getShelf, setShelfVisibility } from './shelf.service.js';
import { shelfResolvers } from '../../graphql/resolvers/shelf.resolvers.js';

let repl: MongoMemoryReplSet;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  await Promise.all([
    Artist.init(), Project.init(), Lyrics.init(), ProjectFork.init(), User.init(),
    ShelfVisibility.init(), Block.init(), Follow.init(),
  ]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await repl.stop();
});
beforeEach(async () => {
  await Promise.all([
    Artist.deleteMany({}), Project.deleteMany({}), Lyrics.deleteMany({}), ProjectFork.deleteMany({}),
    User.deleteMany({}), ShelfVisibility.deleteMany({}), Block.deleteMany({}), Follow.deleteMany({}),
  ]);
});

let userSeq = 0;
const mkUser = async (): Promise<{ id: string; name: string }> => {
  const n = ++userSeq;
  const name = `shelfowner${n}`;
  const { insertedId } = await User.collection.insertOne({ accountName: name, email: `${name}@x.test`, passwordHash: 'x' });
  return { id: insertedId.toString(), name };
};

async function song(
  userId: string,
  artist: string,
  title: string,
  extra: { album?: string; flags?: Record<string, unknown> } = {},
): Promise<string> {
  const r = await createProject(
    { title, metadata: { songName: title, songAlbum: extra.album ?? '', artists: [{ name: artist, role: 'primary' }] } },
    userId,
    '127.0.0.1',
  );
  if (!('publicId' in r)) throw new Error('create failed');
  await Project.updateOne({ publicId: r.publicId }, { $set: { public: true, ...extra.flags } });
  return r.publicId;
}
const artistId = async (userId: string, name: string): Promise<string> =>
  String((await Artist.findOne({ userId, name }).lean())!._id);

const titles = (shelf: Awaited<ReturnType<typeof getShelf>>): string[] =>
  (shelf ?? []).flatMap((a) => a.albums.flatMap((al) => al.tracks.map((t) => (t.project as { title: string }).title)));

describe('artist shelf', () => {
  it('owner sees private artists and private projects', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'Open', { flags: { public: false } });
    const shelf = await getShelf(o.name, false, o.id, { withTracks: true });
    expect(shelf).toHaveLength(1);
    expect(shelf![0]).toMatchObject({ name: 'Drake', isPublic: false, songCount: 1, albumCount: 1 });
    expect(titles(shelf)).toEqual(['Open']);
  });

  it('visitor sees nothing until the artist is made public', async () => {
    const o = await mkUser();
    const v = await mkUser();
    await song(o.id, 'Drake', 'A');
    expect(await getShelf(o.name, false, v.id, { withTracks: true })).toEqual([]);
    await setShelfVisibility(o.id, await artistId(o.id, 'Drake'), null, true);
    const shelf = await getShelf(o.name, false, v.id, { withTracks: true });
    expect(shelf!.map((a) => a.name)).toEqual(['Drake']);
    expect(await getShelf(o.name, false, null, { withTracks: true })).toHaveLength(1);
  });

  it('a private project under a public artist is absent for a visitor and for asVisitor on own profile', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'Shown');
    await song(o.id, 'Drake', 'Hidden', { flags: { public: false } });
    await setShelfVisibility(o.id, await artistId(o.id, 'Drake'), null, true);
    expect(titles(await getShelf(o.name, false, null, { withTracks: true }))).toEqual(['Shown']);
    expect(titles(await getShelf(o.name, true, o.id, { withTracks: true }))).toEqual(['Shown']);
    expect(titles(await getShelf(o.name, false, o.id, { withTracks: true })).sort()).toEqual(['Hidden', 'Shown']);
  });

  it('an unlisted project under a public artist is absent for a visitor', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'Shown');
    await song(o.id, 'Drake', 'Unlisted', { flags: { listed: false } });
    await setShelfVisibility(o.id, await artistId(o.id, 'Drake'), null, true);
    expect(titles(await getShelf(o.name, false, null, { withTracks: true }))).toEqual(['Shown']);
  });

  it('a public artist whose songs are all private is omitted for a visitor', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'Hidden', { flags: { public: false } });
    await setShelfVisibility(o.id, await artistId(o.id, 'Drake'), null, true);
    expect(await getShelf(o.name, false, null, { withTracks: true })).toEqual([]);
  });

  it('album override false hides only that album', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'One', { album: 'Alpha' });
    await song(o.id, 'Drake', 'Two', { album: 'Beta' });
    const id = await artistId(o.id, 'Drake');
    await setShelfVisibility(o.id, id, null, true);
    await setShelfVisibility(o.id, id, 'beta', false);
    const visitor = await getShelf(o.name, false, null, { withTracks: true });
    expect(visitor![0].albums.map((a) => a.title)).toEqual(['Alpha']);
    const owner = await getShelf(o.name, false, o.id, { withTracks: true });
    expect(owner![0].albums.map((a) => `${a.title}:${a.isPublic}`).sort()).toEqual(['Alpha:true', 'Beta:false']);
  });

  it('album override sent with different case/whitespace still hides the album for visitors', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'One', { album: 'Alpha' });
    await song(o.id, 'Drake', 'Two', { album: 'Beta' });
    const id = await artistId(o.id, 'Drake');
    await setShelfVisibility(o.id, id, null, true);
    await setShelfVisibility(o.id, id, '  BETA ', false);
    const visitor = await getShelf(o.name, false, null, { withTracks: true });
    expect(visitor![0].albums.map((a) => a.title)).toEqual(['Alpha']);
  });

  it('viewer blocked by the owner gets an empty shelf', async () => {
    const o = await mkUser();
    const v = await mkUser();
    await song(o.id, 'Drake', 'A');
    await setShelfVisibility(o.id, await artistId(o.id, 'Drake'), null, true);
    await blockUser(o.id, v.id);
    expect(await getShelf(o.name, false, v.id, { withTracks: true })).toBeNull();
    const out = await shelfResolvers.Query.artistShelf({}, { accountName: o.name }, { userId: v.id } as never);
    expect(out).toEqual([]);
  });

  it('setShelfVisibility on another user\'s artistId rejects with status 404', async () => {
    const o = await mkUser();
    const other = await mkUser();
    await song(o.id, 'Drake', 'A');
    const id = await artistId(o.id, 'Drake');
    await expect(setShelfVisibility(other.id, id, null, true)).rejects.toMatchObject({ status: 404 });
    await expect(setShelfVisibility(other.id, 'not-an-id', null, true)).rejects.toMatchObject({ status: 404 });
    await expect(setShelfVisibility(o.id, id, 'x'.repeat(501), true)).rejects.toMatchObject({
      status: 400,
      extensions: { code: 'bad_album_key' },
    });
    expect(await ShelfVisibility.countDocuments({})).toBe(0);
  });

  it('setShelfVisibility upserts by key and rejects without auth with 401', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'A');
    const id = await artistId(o.id, 'Drake');
    await setShelfVisibility(o.id, id, null, true);
    await setShelfVisibility(o.id, id, null, false);
    expect(await ShelfVisibility.countDocuments({})).toBe(1);
    await expect(
      shelfResolvers.Mutation.setShelfVisibility({}, { artistId: id, isPublic: true }, { userId: null } as never),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('withTracks false returns albums with tracks []', async () => {
    const o = await mkUser();
    await song(o.id, 'Drake', 'A', { album: 'Alpha' });
    await song(o.id, 'Drake', 'B', { album: 'Alpha' });
    const shelf = await getShelf(o.name, false, o.id, { withTracks: false });
    expect(shelf![0].albums[0]).toMatchObject({ trackCount: 2, tracks: [] });
    expect(shelf![0].latestEditAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const one = await shelfResolvers.Query.artistShelfArtist(
      {}, { accountName: o.name, artistId: shelf![0].id }, { userId: o.id } as never,
    );
    expect(one!.albums[0].tracks).toHaveLength(2);
    expect(await shelfResolvers.Query.artistShelfArtist(
      {}, { accountName: o.name, artistId: 'bogus' }, { userId: o.id } as never,
    )).toBeNull();
  });
});
