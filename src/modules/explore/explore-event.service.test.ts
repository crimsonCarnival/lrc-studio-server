import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Project from '../projects/project.model.js';
import ExploreEvent from './explore-event.model.js';
import { recordExploreEvents, MAX_EVENTS_PER_CALL } from './explore-event.service.js';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Project.init(), ExploreEvent.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), ExploreEvent.deleteMany({})]);
});

const owner = new mongoose.Types.ObjectId();
const mk = (publicId: string, isPublic = true) =>
  Project.collection.insertOne({ publicId, userId: owner, title: publicId, public: isPublic, createdAt: new Date(), updatedAt: new Date() });

describe('recordExploreEvents', () => {
  it('aggregates impressions, clicks and position per project per UTC day', async () => {
    await mk('p1');
    const now = new Date('2026-11-12T23:59:00Z');
    await recordExploreEvents([
      { publicId: 'p1', type: 'IMPRESSION', position: 0 },
      { publicId: 'p1', type: 'IMPRESSION', position: 4 },
      { publicId: 'p1', type: 'CLICK' },
    ], now);
    await recordExploreEvents([{ publicId: 'p1', type: 'CLICK' }], now);

    const rows = await ExploreEvent.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ publicId: 'p1', impressions: 2, clicks: 2, positionSum: 4 });
    expect(rows[0].day.toISOString()).toBe('2026-11-12T00:00:00.000Z');
  });

  it('ignores unknown and private projects, so forged ids create no rows', async () => {
    await mk('private', false);
    await recordExploreEvents([
      { publicId: 'nope', type: 'IMPRESSION', position: 1 },
      { publicId: 'private', type: 'CLICK' },
    ]);
    expect(await ExploreEvent.countDocuments({})).toBe(0);
  });

  it('caps the batch and clamps hostile positions', async () => {
    await mk('p1');
    const flood = Array.from({ length: MAX_EVENTS_PER_CALL + 25 }, () => ({ publicId: 'p1', type: 'IMPRESSION' as const, position: 1e12 }));
    await recordExploreEvents(flood);
    const row = await ExploreEvent.findOne({}).lean();
    expect(row?.impressions).toBe(MAX_EVENTS_PER_CALL);
    expect(row?.positionSum).toBe(MAX_EVENTS_PER_CALL * 10_000);
  });
});
