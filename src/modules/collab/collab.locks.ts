/**
 * Per-line edit locks for collaborative sessions.
 *
 * Pure in-memory bookkeeping with no I/O, so it is unit-testable; the Hocuspocus
 * wiring lives elsewhere. SINGLE-INSTANCE ONLY, like socket/project-viewers.ts.
 *
 * The holder is the connection, not the user: a second tab of the same subject is
 * denied, so one person cannot hold a line in two places at once.
 * Expired entries are treated as absent on every read, so a stale lock never
 * blocks anyone even before sweep() runs; sweep() only reclaims memory and tells
 * the caller which docs need a fresh snapshot broadcast.
 */

export type LockHolder = { conn: string; subject: string; name: string; colorIndex: number }
export type LockEntry = LockHolder & { expiresAt: number }
export type AcquireResult = { ok: true } | { ok: false; holder: LockHolder }

function toHolder({ conn, subject, name, colorIndex }: LockEntry): LockHolder {
  return { conn, subject, name, colorIndex }
}

export function createLockTable(opts: { idleMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now
  const docs = new Map<string, Map<string, LockEntry>>()

  /** Live (unexpired) entry for a line, or undefined. */
  function live(doc: string, lineId: string): LockEntry | undefined {
    const entry = docs.get(doc)?.get(lineId)
    return entry && entry.expiresAt > now() ? entry : undefined
  }

  function remove(doc: string, lineId: string): void {
    const lines = docs.get(doc)
    if (!lines) return
    lines.delete(lineId)
    if (lines.size === 0) docs.delete(doc)
  }

  function freeWhere(doc: string, match: (e: LockEntry) => boolean): string[] {
    const lines = docs.get(doc)
    if (!lines) return []
    const freed: string[] = []
    for (const [lineId, entry] of [...lines]) {
      if (entry.expiresAt > now() && match(entry)) freed.push(lineId)
      if (entry.expiresAt <= now() || match(entry)) lines.delete(lineId)
    }
    if (lines.size === 0) docs.delete(doc)
    return freed
  }

  return {
    acquire(doc: string, lineId: string, holder: LockHolder): AcquireResult {
      const existing = live(doc, lineId)
      if (existing && existing.conn !== holder.conn) {
        return { ok: false, holder: toHolder(existing) }
      }
      let lines = docs.get(doc)
      if (!lines) {
        lines = new Map()
        docs.set(doc, lines)
      }
      lines.set(lineId, { ...holder, expiresAt: now() + opts.idleMs })
      return { ok: true }
    },

    release(doc: string, lineId: string, conn: string): boolean {
      const entry = live(doc, lineId)
      if (!entry || entry.conn !== conn) return false
      remove(doc, lineId)
      return true
    },

    refresh(doc: string, lineIds: string[], conn: string): void {
      for (const lineId of lineIds) {
        const entry = live(doc, lineId)
        if (entry && entry.conn === conn) entry.expiresAt = now() + opts.idleMs
      }
    },

    releaseAllFor(doc: string, conn: string): string[] {
      return freeWhere(doc, (e) => e.conn === conn)
    },

    releaseSubject(doc: string, subject: string): string[] {
      return freeWhere(doc, (e) => e.subject === subject)
    },

    forceRelease(doc: string, lineId: string): boolean {
      if (!live(doc, lineId)) return false
      remove(doc, lineId)
      return true
    },

    snapshot(doc: string): Record<string, LockHolder> {
      const out: Record<string, LockHolder> = {}
      const lines = docs.get(doc)
      if (!lines) return out
      for (const [lineId, entry] of lines) {
        if (entry.expiresAt > now()) out[lineId] = toHolder(entry)
      }
      return out
    },

    sweep(): string[] {
      const changed: string[] = []
      for (const [doc, lines] of [...docs]) {
        let dropped = false
        for (const [lineId, entry] of [...lines]) {
          if (entry.expiresAt <= now()) {
            lines.delete(lineId)
            dropped = true
          }
        }
        if (lines.size === 0) docs.delete(doc)
        if (dropped) changed.push(doc)
      }
      return changed
    },

    clearDoc(doc: string): void {
      docs.delete(doc)
    },
  }
}
