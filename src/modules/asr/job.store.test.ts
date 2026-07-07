import { describe, it, expect, afterEach } from 'vitest';
import {
  createJob,
  getJob,
  setPhase,
  completeJob,
  failJob,
  cancelJob,
  sweepJobs,
} from './job.store.js';
import { AsrError } from './groq.client.js';
import type { StampResult } from './align.service.js';

// Store is module-level state shared across tests. Use unique userIds per test
// and sweep with a far-future time after each test so tests stay order-independent.
afterEach(() => {
  sweepJobs(Date.now() + 365 * 24 * 60 * 60 * 1000);
});

const result: StampResult[] = [{ index: 0, text: 'hello', timestamp: 0, endTime: 1, status: 'matched', confidence: 1 }] as unknown as StampResult[];

describe('job.store', () => {
  it('createJob starts a job in phase pending', () => {
    const job = createJob('user-1');
    expect(job.phase).toBe('pending');
    expect(getJob(job.id)).toMatchObject({ id: job.id, userId: 'user-1', phase: 'pending' });
  });

  it('createJob throws asr_job_active if the same user already has a non-terminal job, but succeeds after completeJob', () => {
    const first = createJob('user-2');
    expect(() => createJob('user-2')).toThrow(AsrError);
    try {
      createJob('user-2');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AsrError);
      expect((err as AsrError).code).toBe('asr_job_active');
    }
    completeJob(first.id, result);
    const second = createJob('user-2');
    expect(second.id).not.toBe(first.id);
    expect(second.phase).toBe('pending');
  });

  it('cancelJob flips phase to cancelled and aborts the controller', () => {
    const job = createJob('user-3');
    const ok = cancelJob(job.id, 'user-3');
    expect(ok).toBe(true);
    expect(getJob(job.id)?.phase).toBe('cancelled');
    expect(job.abort.signal.aborted).toBe(true);
  });

  it('cancelJob returns false for the wrong userId', () => {
    const job = createJob('user-4');
    const ok = cancelJob(job.id, 'someone-else');
    expect(ok).toBe(false);
    expect(getJob(job.id)?.phase).toBe('pending');
  });

  it('cancelJob returns false for an already-completed job', () => {
    const job = createJob('user-5');
    completeJob(job.id, result);
    const ok = cancelJob(job.id, 'user-5');
    expect(ok).toBe(false);
    expect(getJob(job.id)?.phase).toBe('completed');
  });

  it('sweepJobs(now+11min) removes terminal jobs but keeps in-flight ones', () => {
    const completedJob = createJob('user-6a');
    completeJob(completedJob.id, result);
    const inFlightJob = createJob('user-6b');

    sweepJobs(Date.now() + 11 * 60 * 1000);

    expect(getJob(completedJob.id)).toBeUndefined();
    expect(getJob(inFlightJob.id)).toBeDefined();
    expect(getJob(inFlightJob.id)?.phase).toBe('pending');
  });

  it('failJob sets errorCode and marks the job terminal', () => {
    const job = createJob('user-7');
    failJob(job.id, 'asr_upstream_error');
    const stored = getJob(job.id);
    expect(stored?.phase).toBe('failed');
    expect(stored?.errorCode).toBe('asr_upstream_error');
    expect(stored?.finishedAt).toBeDefined();
  });

  it('setPhase on a terminal job is a no-op', () => {
    const job = createJob('user-8');
    completeJob(job.id, result);
    const finishedAtBefore = getJob(job.id)?.finishedAt;
    setPhase(job.id, 'transcribing');
    const stored = getJob(job.id);
    expect(stored?.phase).toBe('completed');
    expect(stored?.finishedAt).toBe(finishedAtBefore);
  });
});
