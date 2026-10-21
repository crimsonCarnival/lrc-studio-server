import { LRUCache } from '@crimson-carnival/ds-js';
import Block from '../../db/block.model.js';

interface CacheEntry {
  set: Set<string>;
  cachedAt: number;
}

// Cache 500 most-active viewers' block sets
const cache = new LRUCache<string, CacheEntry>(500);

// invalidateBlockCache only clears the process this write landed on. Without
// a TTL, another instance (or this one, if the LRU never evicts under light
// traffic) could keep serving a stale "not blocked" answer indefinitely —
// unbounded staleness on a privacy-sensitive check. This converts that into
// a bounded window; the real fix for cross-instance invalidation is a
// shared store (Redis pub/sub or similar), not attempted here.
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

async function fetchFromDb(viewerId: string): Promise<Set<string>> {
  const blocks = await Block.find({
    $or: [{ blockerId: viewerId }, { blockedId: viewerId }],
  })
    .select('blockerId blockedId')
    .lean();
  const set = new Set<string>();
  for (const b of blocks) {
    set.add(b.blockerId.toString());
    set.add(b.blockedId.toString());
  }
  // The viewer is not "blocked" from their own perspective.
  set.delete(viewerId);
  return set;
}

export async function getCachedBlockedSet(viewerId: string): Promise<Set<string>> {
  const cached = cache.get(viewerId);
  if (cached !== undefined && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.set;
  const fresh = await fetchFromDb(viewerId);
  cache.put(viewerId, { set: fresh, cachedAt: Date.now() });
  return fresh;
}

export function invalidateBlockCache(userId: string): void {
  cache.delete(userId);
}
