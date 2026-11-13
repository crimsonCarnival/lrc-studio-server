import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import Project from '../modules/projects/project.model.js';
import ProjectStar from '../modules/projects/project-star.model.js';
import User from '../modules/users/user.model.js';
import { recomputeTrendingScores } from './trending.job.js';
import { getTrendingProjects } from '../modules/explore/explore.service.js';

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Project.init(), User.init(), ProjectStar.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(async () => {
  await Promise.all([Project.deleteMany({}), User.deleteMany({}), ProjectStar.deleteMany({})]);
});

const day = 24 * 3600_000;
let seq = 0;

async function mkUser(ageDays = 100): Promise<mongoose.Types.ObjectId> {
  const n = ++seq;
  const { insertedId } = await User.collection.insertOne({ accountName: `tj${n}`, email: `tj${n}@x.test`, passwordHash: 'x', createdAt: new Date(Date.now() - ageDays * day) });
  return insertedId;
}

// Raw insert so the test controls createdAt/coverImage/score exactly.
async function mkProject(userId: mongoose.Types.ObjectId, publicId: string, over: Record<string, unknown> = {}) {
  await Project.collection.insertOne({
    publicId, userId, title: publicId, public: true, ownerListed: true, listed: true,
    trendingScore: 0, viewCount: 0, createdAt: new Date(Date.now() - 60 * day), updatedAt: new Date(), ...over,
  });
}

const star = (publicId: string, userId: mongoose.Types.ObjectId) =>
  ProjectStar.collection.insertOne({ publicId, userId, createdAt: new Date() });

const scoreOf = async (publicId: string) => (await Project.findOne({ publicId }).lean())?.trendingScore ?? -1;

describe('recomputeTrendingScores (projects)', () => {
  it('scores idle projects above zero, and Explore lists a covered one first even though it scores no higher', async () => {
    const owner = await mkUser();
    const other = await mkUser();
    await mkProject(owner, 'bare');
    await mkProject(other, 'covered', { coverImage: 'https://img.test/c.jpg', hasCover: true });

    await recomputeTrendingScores();

    expect(await scoreOf('bare')).toBeGreaterThan(0);
    const { projects } = await getTrendingProjects(0, 10);
    expect(projects.map((p) => p.publicId)).toEqual(['covered', 'bare']);
  });

  it('ignores owner self-stars but counts a veteran stranger star', async () => {
    const ownerA = await mkUser();
    const ownerB = await mkUser();
    const stranger = await mkUser();
    await mkProject(ownerA, 'a');
    await mkProject(ownerB, 'b');
    await star('a', ownerA);
    await star('b', stranger);

    await recomputeTrendingScores();

    expect(await scoreOf('b')).toBeGreaterThan(await scoreOf('a'));
  });

  it('discounts a star from a brand-new account', async () => {
    const o1 = await mkUser();
    const o2 = await mkUser();
    await mkProject(o1, 'vet');
    await mkProject(o2, 'sock');
    await star('vet', await mkUser(100));
    await star('sock', await mkUser(0));

    await recomputeTrendingScores();

    expect(await scoreOf('vet')).toBeGreaterThan(await scoreOf('sock'));
  });

  it('does not score private projects', async () => {
    const owner = await mkUser();
    await mkProject(owner, 'priv', { public: false });
    await recomputeTrendingScores();
    expect(await scoreOf('priv')).toBe(0);
  });
});
