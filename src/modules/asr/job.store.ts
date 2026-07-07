import { nanoid } from 'nanoid';
import { AsrError } from './groq.client.js';
import type { StampResult } from './align.service.js';

export type AsrJobPhase = 'pending' | 'fetching_audio' | 'extracting_audio' | 'transcribing' | 'aligning' | 'completed' | 'failed' | 'cancelled';

export type AsrJob = {
  id: string;
  userId: string;
  phase: AsrJobPhase;
  result?: StampResult[];
  errorCode?: string;
  abort: AbortController;
  createdAt: number;
  finishedAt?: number;
  /** Cached audio buffer for waveform display after job completes (YouTube only). */
  audioBuffer?: Buffer;
  audioFormat?: string;
};

const TERMINAL: ReadonlySet<AsrJobPhase> = new Set(['completed', 'failed', 'cancelled']);
const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map<string, AsrJob>();

export function isTerminal(phase: AsrJobPhase): boolean { return TERMINAL.has(phase); }

export function createJob(userId: string): AsrJob {
  for (const job of jobs.values()) {
    if (job.userId === userId && !isTerminal(job.phase)) throw new AsrError('asr_job_active');
  }
  const job: AsrJob = { id: nanoid(12), userId, phase: 'pending', abort: new AbortController(), createdAt: Date.now() };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): AsrJob | undefined { return jobs.get(id); }

export function setPhase(id: string, phase: AsrJobPhase): void {
  const job = jobs.get(id);
  if (!job || isTerminal(job.phase)) return;
  job.phase = phase;
  if (isTerminal(phase)) job.finishedAt = Date.now();
}

export function completeJob(id: string, result: StampResult[]): void {
  const job = jobs.get(id);
  if (!job || isTerminal(job.phase)) return;
  job.result = result;
  setPhase(id, 'completed');
}

export function failJob(id: string, errorCode: string): void {
  const job = jobs.get(id);
  if (!job || isTerminal(job.phase)) return;
  job.errorCode = errorCode;
  setPhase(id, 'failed');
}

export function cancelJob(id: string, userId: string): boolean {
  const job = jobs.get(id);
  if (!job || job.userId !== userId || isTerminal(job.phase)) return false;
  job.abort.abort();
  setPhase(id, 'cancelled');
  return true;
}

export function sweepJobs(now: number = Date.now()): void {
  for (const [id, job] of jobs) {
    if (isTerminal(job.phase) && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** Cache the extracted audio buffer so the client can fetch it for waveform display. */
export function setAudio(id: string, buffer: Buffer, format: string): void {
  const job = jobs.get(id);
  if (job) { job.audioBuffer = buffer; job.audioFormat = format; }
}

/** Return the cached audio buffer, or null if not available. */
export function getAudio(id: string): { buffer: Buffer; format: string } | null {
  const job = jobs.get(id);
  if (!job?.audioBuffer || !job.audioFormat) return null;
  return { buffer: job.audioBuffer, format: job.audioFormat };
}
