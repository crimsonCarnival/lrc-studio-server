import { PriorityQueue } from '@crimson-carnival/ds-js'
import Notification from '../modules/notifications/notification.model.js'
import type { INotification } from '../modules/notifications/notification.model.js'

// Lower number = higher priority (min-heap surfaces these first).
const PRIORITY: Record<string, number> = {
  system: 0, ban: 0, unban: 0, role_changed: 0, admin_granted: 0,
  request_reviewed: 1, request_submitted: 1,
  badge_awarded: 2, xp_changed: 2,
  follow: 3, reaction: 3,
  star: 4, fork: 4,
  admin: 4, verify_email: 4, set_password: 4, password_changed: 4,
}

const comparator = (a: INotification, b: INotification): number => {
  const pa = PRIORITY[a.type] ?? 5
  const pb = PRIORITY[b.type] ?? 5
  if (pa !== pb) return pa - pb
  // same tier → most recent first
  const ta = a.createdAt.getTime()
  const tb = b.createdAt.getTime()
  return tb - ta
}

const heaps = new Map<string, PriorityQueue<INotification>>()
const ttlTimers = new Map<string, ReturnType<typeof setTimeout>>()

function getOrCreate(userId: string): PriorityQueue<INotification> {
  if (!heaps.has(userId)) {
    heaps.set(userId, new PriorityQueue<INotification>(comparator, { stable: true }))
  }
  return heaps.get(userId)!
}

export async function loadHeap(userId: string): Promise<void> {
  clearTimeout(ttlTimers.get(userId))
  ttlTimers.delete(userId)
  const heap = getOrCreate(userId)
  if (!heap.isEmpty()) return  // already loaded (brief reconnect)
  const unread = await Notification.find({ userId, read: false })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean()
  for (const n of unread) heap.enqueue(n as unknown as INotification)
}

export function enqueueNotif(userId: string, notif: INotification): void {
  getOrCreate(userId).enqueue(notif)
}

// Non-destructive: returns top N by priority without dequeuing.
// toArray() returns heap-internal order (not fully sorted), so we sort
// by the same comparator before slicing.
export function peekNotifs(userId: string, limit: number): INotification[] {
  const heap = heaps.get(userId)
  if (!heap) return []
  return heap.toArray().sort(comparator).slice(0, limit)
}

export function clearHeap(userId: string): void {
  heaps.get(userId)?.clear()
  heaps.delete(userId)
}

// Called on socket disconnect — evict after 5 min TTL so brief reconnects reuse heap.
export function scheduleEviction(userId: string): void {
  clearTimeout(ttlTimers.get(userId))
  const timer = setTimeout(() => {
    clearHeap(userId)
    ttlTimers.delete(userId)
  }, 5 * 60 * 1000)
  ttlTimers.set(userId, timer)
}

export function cancelEviction(userId: string): void {
  clearTimeout(ttlTimers.get(userId))
  ttlTimers.delete(userId)
}
