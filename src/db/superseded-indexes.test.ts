import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Project from '../modules/projects/project.model.js';
import Playlist from './playlist.model.js';
import User from './user.model.js';
import { dropSupersededIndexes } from './superseded-indexes.js';

let mem: MongoMemoryServer;

beforeAll(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mem.stop();
});

const names = async (model: { collection: mongoose.Collection }) =>
  (await model.collection.indexes()).map((i) => i.name);

describe('dropSupersededIndexes', () => {
  it('drops the retired indexes, keeps their replacements, and is idempotent', async () => {
    // Simulate a database that predates the wider indexes.
    await Project.collection.createIndex({ public: 1, trendingScore: -1 });
    await Playlist.collection.createIndex({ isPublic: 1, trendingScore: -1 });
    await User.collection.createIndex({ rankScore: -1, isDeleted: 1 });
    await User.collection.createIndex({ rankScore: -1, 'stats.syncedLines': -1, isDeleted: 1 });

    const dropped = await dropSupersededIndexes();
    expect(dropped.sort()).toEqual([
      'playlists.isPublic_1_trendingScore_-1',
      'projects.public_1_trendingScore_-1',
      'users.rankScore_-1_isDeleted_1',
      'users.rankScore_-1_stats.syncedLines_-1_isDeleted_1',
    ]);

    // The trending indexes now carry `ownerListed` as a second equality key.
    expect(await names(Project)).toContain('public_1_ownerListed_1_trendingScore_-1_createdAt_-1');
    expect(await names(Project)).not.toContain('public_1_trendingScore_-1');
    expect(await names(Playlist)).toContain('isPublic_1_ownerListed_1_trendingScore_-1_createdAt_-1');
    // Both earlier rankScore indexes are retired in favour of the one that
    // carries the resolver's `_id` sort tiebreak.
    expect(await names(User)).toContain('rankScore_-1_stats.syncedLines_-1__id_1_isDeleted_1');
    expect(await names(User)).not.toContain('rankScore_-1_stats.syncedLines_-1_isDeleted_1');
    // An unrelated index sharing the prefix must survive — `{public, starCount}`
    // was deliberately left un-widened, so it is not superseded.
    expect(await names(Project)).toContain('public_1_starCount_-1');

    expect(await dropSupersededIndexes()).toEqual([]);
  });

  it('leaves the old index alone while its replacement is missing', async () => {
    await Project.collection.dropIndex('public_1_ownerListed_1_trendingScore_-1_createdAt_-1');
    await Project.collection.createIndex({ public: 1, trendingScore: -1 });
    // init() is memoised, so the replacement is not rebuilt here — the same
    // state as a replacement build that failed.
    expect(await dropSupersededIndexes()).toEqual([]);
    expect(await names(Project)).toContain('public_1_trendingScore_-1');
  });
});
