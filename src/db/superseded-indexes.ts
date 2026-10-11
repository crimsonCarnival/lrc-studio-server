import type { Collection, Model } from 'mongoose';
import Project from '../modules/projects/project.model.js';
import Playlist from './playlist.model.js';
import User from './user.model.js';

type IndexKey = Record<string, 1 | -1>;

interface SupersededIndex {
  init: () => Promise<unknown>;
  collection: Collection;
  old: IndexKey;
  replacement: IndexKey;
}

function superseded<T>(model: Model<T>, old: IndexKey, replacement: IndexKey): SupersededIndex {
  return { init: () => model.init(), collection: model.collection, old, replacement };
}

// Mongoose builds indexes added to a schema but never drops ones removed from
// it, so an index replaced by a wider one stays behind and keeps costing every
// write. Each entry pairs a retired index with the one that covers its queries.
const SUPERSEDED_INDEXES: SupersededIndex[] = [
  // The trending indexes gained `ownerListed` as a second equality key
  // (owner-visibility filtering), so BOTH earlier forms are retired: the
  // original two-key index and the createdAt-tiebreak one that replaced it.
  // Each is listed against the current replacement rather than chained, so a
  // database that only ever had the oldest still gets it dropped.
  //
  // Only the trending indexes changed. `{public, starCount}` and
  // `{public, createdAt}` were left as they are: no query filters `public` and
  // sorts by those off an index (project search sorts after a $search stage or
  // over an $or filter), so widening them would have been churn for nothing.
  superseded(Project, { public: 1, trendingScore: -1 }, { public: 1, ownerListed: 1, trendingScore: -1, createdAt: -1 }),
  superseded(Project, { public: 1, trendingScore: -1, createdAt: -1 }, { public: 1, ownerListed: 1, trendingScore: -1, createdAt: -1 }),
  superseded(Playlist, { isPublic: 1, trendingScore: -1 }, { isPublic: 1, ownerListed: 1, trendingScore: -1, createdAt: -1 }),
  superseded(Playlist, { isPublic: 1, trendingScore: -1, createdAt: -1 }, { isPublic: 1, ownerListed: 1, trendingScore: -1, createdAt: -1 }),
  // Both earlier rankScore indexes are prefixes of the current one, so it
  // answers everything they did. (It gained the `_id` key when the leaderboard
  // resolver started appending `_id` as its final sort tiebreak.) They are
  // listed against the same replacement rather than chained, so a database that
  // only ever had the oldest of them still gets it dropped.
  superseded(User, { rankScore: -1, isDeleted: 1 }, { rankScore: -1, 'stats.syncedLines': -1, _id: 1, isDeleted: 1 }),
  superseded(
    User,
    { rankScore: -1, 'stats.syncedLines': -1, isDeleted: 1 },
    { rankScore: -1, 'stats.syncedLines': -1, _id: 1, isDeleted: 1 },
  ),
];

// Key order is part of an index's identity, so compare the serialized form.
const sameKey = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Drops retired indexes. Idempotent, and matched by key rather than name so a
 * custom-named index is still found. An old index is only dropped once its
 * replacement exists — otherwise its queries would fall back to a collection
 * scan until the build finishes — so a failed build just defers the drop to
 * the next startup.
 */
export async function dropSupersededIndexes(): Promise<string[]> {
  const dropped: string[] = [];
  for (const { init, collection, old, replacement } of SUPERSEDED_INDEXES) {
    // Resolves once the schema's indexes, including the replacement, are built.
    await init();
    const indexes = await collection.indexes();
    const stale = indexes.find((idx) => sameKey(idx.key, old));
    if (!stale?.name) continue;
    if (!indexes.some((idx) => sameKey(idx.key, replacement))) continue;
    await collection.dropIndex(stale.name);
    dropped.push(`${collection.collectionName}.${stale.name}`);
  }
  return dropped;
}
