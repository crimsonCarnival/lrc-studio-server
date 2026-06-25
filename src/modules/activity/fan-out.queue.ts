import { Queue } from '@crimson-carnival/ds-js';
import { getIO } from '../../socket/socket.manager.js';

export interface FanOutJob {
  actorId: string;
  followerIds: string[];
  activity: unknown;
}

const BATCH_SIZE = 50;
const OVERFLOW_WARN = 1000;

const queue = new Queue<FanOutJob>();
let processing = false;

function emit(userId: string, activity: unknown): void {
  try { getIO().to(`user:${userId}`).emit('feed:new', activity); } catch { /* socket not ready */ }
}

async function drain(): Promise<void> {
  if (processing) return;
  processing = true;
  while (!queue.isEmpty()) {
    if (queue.size > OVERFLOW_WARN) {
      console.warn(`[fan-out] queue size ${queue.size} exceeds ${OVERFLOW_WARN} — consider a job queue`);
    }
    const job = queue.dequeue()!;
    const batch = job.followerIds.slice(0, BATCH_SIZE);
    for (const followerId of batch) {
      emit(followerId, job.activity);
    }
    // yield to event loop between jobs
    await new Promise(r => setImmediate(r));
  }
  processing = false;
}

export function enqueueFanOut(job: FanOutJob): void {
  queue.enqueue(job);
  // fire-and-forget drain
  drain().catch(() => {});
}
