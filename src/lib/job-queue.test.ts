import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { startJobQueue, runJobQueue, stopJobQueue, defineRecurring, defineOnce, scheduleOnce } from './job-queue.js';

let mem: MongoMemoryServer;
const failures: string[] = [];

beforeAll(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await startJobQueue((_err, name) => { failures.push(name); }, '100 milliseconds');
}, 60000);
afterAll(async () => {
  await stopJobQueue();
  await mongoose.disconnect();
  await mem.stop();
});

const pending = (name: string) => mongoose.connection.db!.collection('pulseJobs').countDocuments({ name });

describe('job queue', () => {
  it('runs a recurring job and a deduplicated one-off, then lets it be queued again', async () => {
    const recurring = vi.fn(async () => undefined);
    const once = vi.fn(async (_data: { userId: string }) => undefined);

    await defineRecurring('test-recurring', '1 hour', recurring);
    defineOnce('test-once', once);

    // A burst for one key collapses to one pending job; another key is separate.
    await scheduleOnce('test-once', 'u1', { userId: 'u1' }, 'in 1 second');
    await scheduleOnce('test-once', 'u1', { userId: 'u1' }, 'in 1 second');
    await scheduleOnce('test-once', 'u2', { userId: 'u2' }, 'in 1 second');
    expect(await pending('test-once')).toBe(2);

    await runJobQueue();

    await vi.waitFor(() => expect(recurring).toHaveBeenCalledTimes(1), { timeout: 10000 });
    await vi.waitFor(() => expect(once).toHaveBeenCalledTimes(2), { timeout: 10000 });
    expect(once.mock.calls.map(([d]) => d.userId).sort()).toEqual(['u1', 'u2']);

    // One-offs remove themselves, so the same key can be queued again.
    await vi.waitFor(async () => expect(await pending('test-once')).toBe(0), { timeout: 10000 });
    await scheduleOnce('test-once', 'u1', { userId: 'u1' }, 'in 1 second');
    await vi.waitFor(() => expect(once).toHaveBeenCalledTimes(3), { timeout: 10000 });

    expect(failures).toEqual([]);
  }, 40000);

  it('reports a throwing job through onFail', async () => {
    defineOnce('test-failing', async () => { throw new Error('boom'); });
    await scheduleOnce('test-failing', 'k', {}, 'in 1 second');
    await vi.waitFor(() => expect(failures).toContain('test-failing'), { timeout: 10000 });
  }, 20000);
});
