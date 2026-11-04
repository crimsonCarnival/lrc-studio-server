/**
 * Closes the gap between authenticating a connection and attaching it. Revoking sweeps the connections
 * already attached, and one whose auth read the database just before the revocation attaches right
 * after that sweep. So auth captures a position here first, and attach asks whether anything revoked
 * this identity since. No database query: this runs while a client is waiting to sync.
 *
 * Bounded by TTL and entry count. Both fail safe: a capture too old to answer for is reported as
 * revoked, and that only costs the client a reconnect and a fresh auth.
 * SINGLE-INSTANCE ONLY, like the rest of the collab server's in-memory state.
 */
export type RevocationCapture = { seq: number; at: number }

export function createRevocationLog(opts: { ttlMs: number; maxEntries: number; now?: () => number }) {
  const now = opts.now ?? Date.now
  // Insertion order is age order: a key revoked again is deleted and re-added.
  const entries = new Map<string, RevocationCapture>()
  let seq = 0
  /** Seq of the newest entry evicted by the count bound, while it was still inside its TTL. */
  let evictedSeq = 0

  function prune(): void {
    for (const [key, entry] of entries) {
      const expired = now() - entry.at >= opts.ttlMs
      if (!expired && entries.size <= opts.maxEntries) return
      if (!expired) evictedSeq = entry.seq
      entries.delete(key)
    }
  }

  return {
    capture(): RevocationCapture {
      return { seq, at: now() }
    },

    revoke(key: string): void {
      entries.delete(key)
      entries.set(key, { seq: ++seq, at: now() })
      prune()
    },

    revokedSince(capture: RevocationCapture, keys: string[]): boolean {
      if (now() - capture.at >= opts.ttlMs || capture.seq < evictedSeq) return true
      return keys.some((key) => (entries.get(key)?.seq ?? 0) > capture.seq)
    },

    size(): number {
      return entries.size
    },
  }
}
