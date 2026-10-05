import mongoose from 'mongoose';
import { Pulse } from '@pulsecron/pulse';
import type { Job, JobAttributesData } from '@pulsecron/pulse';

/**
 * Mongo-backed job queue (Pulse). Jobs are documents in `pulseJobs`, claimed
 * with a lock, so a schedule fires once across all server instances and
 * survives restarts — unlike setInterval, which fires once per instance and
 * forgets everything on deploy.
 */

type Handler<T extends JobAttributesData> = (data: T) => Promise<unknown>;

let pulse: Pulse | null = null;

function requireQueue(): Pulse {
  if (!pulse) throw new Error('Job queue not started');
  return pulse;
}

/** Connects to the already-open Mongoose connection; call once after it is ready. */
export async function startJobQueue(
  onFail: (err: Error, jobName: string) => void,
  processEvery = '15 seconds',
): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Job queue needs an open MongoDB connection');
  const instance = new Pulse({ mongo: db, processEvery });
  instance.on('fail', (err: Error, job: Job) => onFail(err, job.attrs.name));
  pulse = instance;
}

/** Begins polling. Call after every handler is registered. */
export async function runJobQueue(): Promise<void> {
  await requireQueue().start();
}

/** Stops polling and releases this instance's locks so another can take over. */
export async function stopJobQueue(): Promise<void> {
  const instance = pulse;
  pulse = null;
  await instance?.stop();
}

/** Registers a recurring job. `interval` is a cron expression or e.g. '15 minutes'. */
export async function defineRecurring(name: string, interval: string, handler: Handler<JobAttributesData>): Promise<void> {
  const queue = requireQueue();
  queue.define(name, async () => { await handler({}); });
  await queue.every(interval, name, undefined, { timezone: 'UTC' });
}

/** Registers the handler for a one-off job scheduled with scheduleOnce. */
export function defineOnce<T extends JobAttributesData>(name: string, handler: Handler<T>): void {
  requireQueue().define<T>(name, async (job) => {
    // Remove before running, not after: a request arriving mid-run must be able
    // to queue a fresh job rather than be swallowed by this one's dedup key.
    await job.remove();
    await handler(job.attrs.data);
  });
}

/**
 * Queues `name` to run at `when` unless one with the same `key` is already
 * pending. The existing job keeps its time, so a burst of calls is covered by
 * one run that lands within the window and after the last call in it.
 */
export async function scheduleOnce<T extends JobAttributesData>(name: string, key: string, data: T, when: string): Promise<void> {
  await requireQueue()
    .create(name, { ...data, dedupKey: key })
    .unique({ name, 'data.dedupKey': key }, { insertOnly: true })
    .schedule(when)
    .save();
}
