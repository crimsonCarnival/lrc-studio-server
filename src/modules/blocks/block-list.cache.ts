import { LRUCache } from '@crimson-carnival/ds-js';
import Block from '../../db/block.model.js';

// Cache 500 most-active viewers' block sets
const cache = new LRUCache<string, Set<string>>(500);

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
  if (cached !== undefined) return cached;
  const fresh = await fetchFromDb(viewerId);
  cache.put(viewerId, fresh);
  return fresh;
}

export function invalidateBlockCache(userId: string): void {
  cache.delete(userId);
}
