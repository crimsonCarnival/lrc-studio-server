import { PriorityQueue } from '@crimson-carnival/ds-js'
import StaffRequest from './request.model.js'
import type { IStaffRequest, RequestType } from './request.model.js'

// Lower number = higher urgency (surfaces first in the min-heap).
const URGENCY: Record<RequestType, number> = {
  block_ip: 0,
  block_device: 0,
  xp_adjust: 1,
  badge_delete: 1,
  badge_create: 2,
  badge_update: 2,
  level_create: 2,
  level_update: 2,
  level_delete: 2,
}

// Stable mode ensures FIFO ordering among requests of equal urgency.
const pq = new PriorityQueue<IStaffRequest>(
  (a, b) => (URGENCY[a.type] ?? 9) - (URGENCY[b.type] ?? 9),
  { stable: true }
)

let initialized = false

export async function initRequestQueue(): Promise<void> {
  if (initialized) return
  initialized = true
  const pending = await StaffRequest.find({ status: 'pending' }).lean()
  for (const r of pending) pq.enqueue(r as unknown as IStaffRequest)
}

export function enqueueRequest(req: IStaffRequest): void {
  pq.enqueue(req)
}

/**
 * Returns all pending requests in priority order (urgency asc, then insertion order).
 * Does NOT drain the queue — safe to call repeatedly.
 * O(n log n) rebuild — acceptable at staff-request volume (typically <20 pending)
 */
export function getPendingRequests(): IStaffRequest[] {
  // toArray() returns internal heap order (not priority order).
  // To produce a proper priority-ordered snapshot we drain a temporary PQ.
  const snapshot = new PriorityQueue<IStaffRequest>(
    (a, b) => (URGENCY[a.type] ?? 9) - (URGENCY[b.type] ?? 9),
    { stable: true }
  )
  for (const item of pq.toArray()) snapshot.enqueue(item)
  const result: IStaffRequest[] = []
  while (!snapshot.isEmpty()) {
    result.push(snapshot.dequeue()!)
  }
  return result
}

/**
 * Removes the request with the given MongoDB _id from the in-memory queue.
 * Uses rebuild approach since PriorityQueue has no cancel method.
 * O(n log n) rebuild — acceptable at staff-request volume (typically <20 pending)
 */
export function removeRequest(id: string): void {
  const remaining = pq.toArray().filter(r => r._id?.toString() !== id)
  pq.clear()
  for (const r of remaining) pq.enqueue(r)
}
