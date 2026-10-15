import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Project from './project.model.js';
import Upload from '../uploads/upload.model.js';
import { backfillProjectSlugs } from './project-slug.migration.js';

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
  await Promise.all([Project.deleteMany({}), Upload.deleteMany({})]);
});

// Rows are inserted through the raw collection: the model's pre-validate hook
// would otherwise fill the slug and there would be nothing to migrate.
const insert = (doc: Record<string, unknown>) =>
  Project.collection.insertOne({ publicId: `p${Math.random().toString(36).slice(2, 11)}`, public: true, ...doc });

const slugOf = async (publicId: string) =>
  (await Project.collection.findOne({ publicId }) as { slug?: string } | null)?.slug;

describe('backfillProjectSlugs', () => {
  it('fills accents, CJK, kana and title-only rows; names nameless rows; leaves filled rows alone', async () => {
    await insert({ publicId: 'accent0001', metadata: { songArtist: 'Beyoncé', songName: "Don't Hurt Yourself" } });
    await insert({ publicId: 'cjk0000001', metadata: { songArtist: '米津玄師', songName: 'ありがとう' } });
    await insert({ publicId: 'kana000001', title: 'が' });
    await insert({ publicId: 'titleonly1', title: 'Just A Title', metadata: { songName: '', songArtist: '' } });
    const upload = await Upload.collection.insertOne({ title: 'From Upload', fileName: 'x.mp3' });
    await insert({ publicId: 'empty00001', title: '', metadata: {}, uploadId: upload.insertedId });
    await insert({ publicId: 'empty00002', title: '   ', metadata: {} });
    await insert({ publicId: 'filled0001', title: 'Whatever', slug: 'kept-as-is', metadata: { songName: 'Different' } });

    const first = await backfillProjectSlugs({ batchSize: 2 });

    expect(await slugOf('accent0001')).toBe('beyonce-dont-hurt-yourself');
    expect(await slugOf('cjk0000001')).toBe('米津玄師-ありがとう');
    expect(await slugOf('kana000001')).toBe('が');
    expect(await slugOf('titleonly1')).toBe('just-a-title');
    expect(await slugOf('empty00001')).toBe('from-upload');
    expect(await slugOf('empty00002')).toBe('untitled');
    expect(await slugOf('filled0001')).toBe('kept-as-is');
    expect((await Project.collection.findOne({ publicId: 'empty00001' }) as { title: string }).title).toBe('From Upload');
    expect((await Project.collection.findOne({ publicId: 'empty00002' }) as { title: string }).title).toBe('untitled');
    expect(first).toMatchObject({ scanned: 6, updated: 6, fallbackTitles: 2 });
    expect(await Project.countDocuments({ $or: [{ slug: { $exists: false } }, { slug: '' }] })).toBe(0);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await insert({ publicId: 'a000000001', metadata: { songName: 'Creep' } });
    await insert({ publicId: 'b000000001', title: '' });
    await backfillProjectSlugs();
    const before = await Project.collection.find({}).sort({ publicId: 1 }).toArray();

    const second = await backfillProjectSlugs();

    expect(second).toEqual({ scanned: 0, updated: 0, unchanged: 0, fallbackTitles: 0 });
    expect(await Project.collection.find({}).sort({ publicId: 1 }).toArray()).toEqual(before);
  });

  it('does not touch updatedAt', async () => {
    const updatedAt = new Date('2020-01-01T00:00:00Z');
    await insert({ publicId: 'time000001', title: 'T', updatedAt });
    await backfillProjectSlugs();
    expect((await Project.collection.findOne({ publicId: 'time000001' }) as { updatedAt: Date }).updatedAt).toEqual(updatedAt);
  });

  it('dry run reports but writes nothing; recompute rewrites filled rows', async () => {
    await insert({ publicId: 'dry0000001', title: 'Dry' });
    expect((await backfillProjectSlugs({ dryRun: true })).updated).toBe(1);
    expect(await slugOf('dry0000001')).toBeUndefined();

    await insert({ publicId: 'old0000001', title: 'Fresh', slug: 'stale' });
    await backfillProjectSlugs({ recompute: true });
    expect(await slugOf('old0000001')).toBe('fresh');
  });
});

describe('Project model keeps slug in step on save', () => {
  it('derives it on create and on save', async () => {
    const p = await Project.create({ title: 'x', metadata: { songArtist: 'Radiohead', songName: 'Creep' } });
    expect(p.slug).toBe('radiohead-creep');
    p.metadata!.songName = 'Karma Police';
    await p.save();
    expect((await Project.findById(p._id))!.slug).toBe('radiohead-karma-police');
  });
});
