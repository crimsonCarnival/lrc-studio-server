import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../modules/badges/badge.service.js', () => ({
  scheduleSyncStatsRefresh: () => undefined,
  updateStreak: async () => undefined,
}));

import Project from '../../modules/projects/project.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import CollabSession from '../../modules/collab/collab-session.model.js';
import { deriveErrorCode } from '../error-code.js';
import { lyricsResolvers } from './lyrics.resolvers.js';
import type { Context } from './context.js';

// updateLyrics has no live client caller but is still in the schema, so it must
// not be a way around the collab_active guard that updateProject enforces.

let mongo: MongoMemoryServer;
const PUBLIC_ID = 'lyrguard01';
const ownerId = new mongoose.Types.ObjectId().toString();
const SECTIONS = [{ label: null, id: null, depth: null, timestamp: null, lines: [{ id: 'l1', text: 'solo' }] }];
const call = () => lyricsResolvers.Mutation.updateLyrics(null, { publicId: PUBLIC_ID, input: { sections: SECTIONS } }, { userId: ownerId } as Context);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), CollabSession.deleteMany({})]);
  await Project.collection.insertOne({ publicId: PUBLIC_ID, userId: new mongoose.Types.ObjectId(ownerId), title: 'T', slug: 't' });
  await Lyrics.collection.insertOne({ publicId: PUBLIC_ID, editorMode: 'lrc', sections: [] });
});

describe('updateLyrics during a live collab session', () => {
  it('is refused with collab_active and writes nothing', async () => {
    await CollabSession.create({ publicId: PUBLIC_ID, ownerId });
    let code: string | undefined;
    try {
      await call();
    } catch (err) {
      code = deriveErrorCode(err);
    }
    expect(code).toBe('collab_active');
    expect((await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections).toEqual([]);
  });

  it('still writes when no session is live', async () => {
    await CollabSession.create({ publicId: PUBLIC_ID, ownerId, endedAt: new Date() });
    await call();
    expect((await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text).toBe('solo');
  });
});
