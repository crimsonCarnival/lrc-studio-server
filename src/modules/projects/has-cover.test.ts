import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Project from './project.model.js';
import { backfillHasCover } from './has-cover.backfill.js';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Project.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Project.deleteMany({});
});

const owner = new mongoose.Types.ObjectId();
const raw = (publicId: string, over: Record<string, unknown>) =>
  Project.collection.insertOne({ publicId, userId: owner, title: publicId, createdAt: new Date(), updatedAt: new Date(), ...over });
const flag = async (publicId: string) => (await Project.collection.findOne({ publicId }))?.hasCover;

describe('hasCover stays in step with coverImage', () => {
  it('is set on create', async () => {
    await Project.create({ publicId: 'with', title: 'with', userId: owner, coverImage: 'https://img.test/a.jpg' });
    await Project.create({ publicId: 'without', title: 'without', userId: owner });
    expect(await flag('with')).toBe(true);
    expect(await flag('without')).toBe(false);
  });

  it('follows coverImage through findOneAndUpdate, updateOne and $unset', async () => {
    await Project.create({ publicId: 'p', title: 'p', userId: owner });
    await Project.findOneAndUpdate({ publicId: 'p' }, { $set: { coverImage: 'https://img.test/a.jpg' } });
    expect(await flag('p')).toBe(true);
    await Project.updateOne({ publicId: 'p' }, { coverImage: '' });
    expect(await flag('p')).toBe(false);
    await Project.updateOne({ publicId: 'p' }, { $set: { coverImage: 'https://img.test/b.jpg' } });
    await Project.updateOne({ publicId: 'p' }, { $unset: { coverImage: 1 } });
    expect(await flag('p')).toBe(false);
  });

  it('leaves hasCover alone when an update does not touch coverImage', async () => {
    await Project.create({ publicId: 'p', title: 'p', userId: owner, coverImage: 'https://img.test/a.jpg' });
    await Project.findOneAndUpdate({ publicId: 'p' }, { $set: { title: 'renamed' } });
    expect(await flag('p')).toBe(true);
  });
});

describe('backfillHasCover', () => {
  it('dry run counts without writing; apply fixes only wrong flags and is idempotent', async () => {
    await raw('legacy-cover', { coverImage: 'https://img.test/a.jpg' }); // field missing
    await raw('legacy-empty', { coverImage: '' });
    await raw('legacy-absent', {});
    await raw('already-right', { coverImage: 'https://img.test/b.jpg', hasCover: true });
    await raw('stale', { coverImage: '', hasCover: true });

    expect(await backfillHasCover(false)).toEqual({ toSetTrue: 1, toSetFalse: 3 });
    expect(await flag('legacy-cover')).toBeUndefined();

    expect(await backfillHasCover(true)).toEqual({ toSetTrue: 1, toSetFalse: 3 });
    expect(await flag('legacy-cover')).toBe(true);
    expect(await flag('legacy-empty')).toBe(false);
    expect(await flag('legacy-absent')).toBe(false);
    expect(await flag('stale')).toBe(false);
    expect(await flag('already-right')).toBe(true);

    expect(await backfillHasCover(true)).toEqual({ toSetTrue: 0, toSetFalse: 0 });
  });

  it('does not bump updatedAt', async () => {
    const before = new Date('2026-01-01T00:00:00Z');
    await raw('p', { coverImage: 'https://img.test/a.jpg', updatedAt: before });
    await backfillHasCover(true);
    expect((await Project.collection.findOne({ publicId: 'p' }))?.updatedAt).toEqual(before);
  });
});
