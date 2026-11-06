import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

vi.mock('../../socket/socket.manager.js', () => ({ getIO: () => { throw new Error('no socket'); } }));

import Project from './project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Notification from '../notifications/notification.model.js';
import { privatizeIncomplete } from './privatize-incomplete.service.js';

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), Lyrics.deleteMany({}), Notification.deleteMany({})]);
});

type L = { text?: string; timestamp?: number | null; type?: string };
const oid = () => new mongoose.Types.ObjectId();

// Raw inserts keep the fixture exact (no hooks, no defaults) and let us pin updatedAt.
async function seed(publicId: string, lines: L[] | null, opts: { owner?: mongoose.Types.ObjectId | null; pub?: boolean } = {}) {
  const updatedAt = new Date('2020-01-01T00:00:00Z');
  await Project.collection.insertOne({
    publicId, title: `T-${publicId}`, public: opts.pub ?? true, userId: opts.owner === undefined ? oid() : opts.owner,
    createdAt: updatedAt, updatedAt,
  });
  if (lines) {
    await Lyrics.collection.insertOne({ publicId, sections: [{ label: 'Verse', timestamp: null, lines: lines.map((l) => ({ text: 'x', ...l })) }] });
  }
}
const isPublic = async (id: string) => (await Project.collection.findOne({ publicId: id }) as { public: boolean }).public;

describe('privatizeIncomplete', () => {
  it('privatizes a public project with one untimed line, keeps fully timed public', async () => {
    await seed('partial001', [{ timestamp: 1 }, { timestamp: null }]);
    await seed('full0000001', [{ timestamp: 1 }, { timestamp: 2 }]);
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res.changed).toBe(1);
    expect(res.matched).toEqual([{ publicId: 'partial001', title: 'T-partial001', timed: 1, total: 2 }]);
    expect(await isPublic('partial001')).toBe(false);
    expect(await isPublic('full0000001')).toBe(true);
  });

  it('ignores section markers and treats timestamp 0 as timed', async () => {
    await seed('markers0001', [{ type: 'section', timestamp: null }, { timestamp: 0 }, { timestamp: 4 }]);
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res).toEqual({ matched: [], changed: 0 });
    expect(await isPublic('markers0001')).toBe(true);
  });

  it('counts empty and missing lyrics as incomplete; leaves private projects alone', async () => {
    await seed('empty000001', []);
    await seed('nolyrics001', null);
    await seed('private0001', [{ timestamp: null }], { pub: false });
    const res = await privatizeIncomplete({ dryRun: false });
    expect(res.matched.map((m) => m.publicId).sort()).toEqual(['empty000001', 'nolyrics001']);
    expect(res.changed).toBe(2);
  });

  it('is idempotent and preserves updatedAt', async () => {
    await seed('partial001', [{ timestamp: null }]);
    expect((await privatizeIncomplete({ dryRun: false })).changed).toBe(1);
    expect(await privatizeIncomplete({ dryRun: false })).toEqual({ matched: [], changed: 0 });
    const doc = await Project.collection.findOne({ publicId: 'partial001' }) as { updatedAt: Date };
    expect(doc.updatedAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('dry run lists but writes nothing and sends nothing', async () => {
    await seed('partial001', [{ timestamp: null }]);
    const evict = vi.fn(async () => undefined);
    const res = await privatizeIncomplete({ dryRun: true, evictNonOwners: evict });
    expect(res.changed).toBe(0);
    expect(res.matched).toHaveLength(1);
    expect(await isPublic('partial001')).toBe(true);
    expect(await Notification.countDocuments({})).toBe(0);
    expect(evict).not.toHaveBeenCalled();
  });

  it('sends one system notification per owner, not per project', async () => {
    const a = oid();
    const b = oid();
    await seed('a000000001', [{ timestamp: null }], { owner: a });
    await seed('a000000002', [], { owner: a });
    await seed('b000000001', [{ timestamp: null }], { owner: b });
    await privatizeIncomplete({ dryRun: false });
    const notes = await Notification.find({}).lean();
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.type === 'system')).toBe(true);
    const forA = notes.find((n) => n.userId.equals(a));
    expect(forA?.meta).toEqual({ kind: 'projects_privatized', count: 2 });
  });

  it('handles owner-less projects: privatized, nobody notified; eviction is called per project', async () => {
    await seed('guest000001', [{ timestamp: null }], { owner: null });
    const evict = vi.fn(async () => undefined);
    const res = await privatizeIncomplete({ dryRun: false, evictNonOwners: evict });
    expect(res.changed).toBe(1);
    expect(await isPublic('guest000001')).toBe(false);
    expect(await Notification.countDocuments({})).toBe(0);
    expect(evict).toHaveBeenCalledWith('guest000001', null);
  });
});
