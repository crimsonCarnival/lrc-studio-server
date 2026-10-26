import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import User from '../users/user.model.js';
import JobLog from '../../db/job-log.model.js';
import Project from '../projects/project.model.js';
import { listJobLogs } from './admin.service.js';

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
  await Promise.all([User.deleteMany({}), JobLog.deleteMany({}), Project.deleteMany({})]);
});

async function mkUser(accountName: string): Promise<mongoose.Types.ObjectId> {
  const res = await User.collection.insertOne({
    accountName, email: `${accountName}@x.test`, passwordHash: 'x', isDeleted: false, role: 'user', permissions: [], ban: { active: false },
  });
  return res.insertedId;
}

describe('listJobLogs', () => {
  it('lists newest first with the user and the project it ran for', async () => {
    const userId = await mkUser('sam');
    const project = await Project.collection.insertOne({ publicId: 'abc1234567', title: 'Song', userId });
    await JobLog.create({ jobType: 'extract_lyrics', status: 'failed', error: 'lyrics_unavailable', userId, publicId: project ? 'abc1234567' : null, query: { track: 'T', artist: 'A' }, durationMs: 120 });
    await JobLog.create({ jobType: 'infer_end_times', status: 'succeeded', userId, lineCount: 12 });

    const { logs, total } = await listJobLogs({}) as { logs: Record<string, any>[]; total: number };
    expect(total).toBe(2);
    expect(logs[0].jobType).toBe('infer_end_times');
    expect(logs[1]).toMatchObject({
      status: 'failed',
      error: 'lyrics_unavailable',
      durationMs: 120,
      query: { track: 'T', artist: 'A' },
      user: { accountName: 'sam' },
      project: { publicId: 'abc1234567', title: 'Song', ownerAccountName: 'sam' },
    });
  });

  it('filters by status and type, and ignores values it does not know', async () => {
    await JobLog.create({ jobType: 'extract_lyrics', status: 'failed' });
    await JobLog.create({ jobType: 'extract_lyrics', status: 'succeeded' });
    await JobLog.create({ jobType: 'infer_end_times', status: 'failed' });

    expect((await listJobLogs({ status: 'failed' }) as { total: number }).total).toBe(2);
    expect((await listJobLogs({ status: 'failed', jobType: 'infer_end_times' }) as { total: number }).total).toBe(1);
    expect((await listJobLogs({ status: '$ne' }) as { total: number }).total).toBe(3);
  });
});
