import { LRUCache } from '@crimson-carnival/ds-js';
import UserPreferences, { type IUserPreferences } from './user-preferences.model.js';

interface CacheEntry {
  prefs: IUserPreferences;
  cachedAt: number;
}

// Cache 1000 most-recently-accessed preference docs
const cache = new LRUCache<string, CacheEntry>(1000);
// This process's own writes invalidate correctly (updatePreferences below
// re-puts after every save). The gap is cross-instance: another process
// holding a stale entry — e.g. a visibility change made on instance A isn't
// seen by instance B until its entry naturally evicts, which may be never
// under light traffic. TTL bounds that window; see block-list.cache.ts for
// the same fix with the fuller reasoning.
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

// `.lean()` does not apply schema defaults, so documents created before a field
// existed come back without it. Fill in the defaults for fields added later so
// callers (and non-null GraphQL fields) never see `undefined`.
function withDefaults(prefs: IUserPreferences): IUserPreferences {
  return {
    ...prefs,
    showActivityHeatmap: prefs.showActivityHeatmap === true,
    showXpProgress: prefs.showXpProgress === true,
    wallEnabled: prefs.wallEnabled !== false,
    allowTags: prefs.allowTags !== false,
    country: prefs.country ?? null,
    notifications: {
      ...prefs.notifications,
      streak_warning: prefs.notifications?.streak_warning !== false,
      followed_project: prefs.notifications?.followed_project !== false,
      wall_comment: prefs.notifications?.wall_comment !== false,
      mention: prefs.notifications?.mention !== false,
      level_up: prefs.notifications?.level_up !== false,
      playlist_saved: prefs.notifications?.playlist_saved !== false,
      star_milestone: prefs.notifications?.star_milestone !== false,
      new_device: prefs.notifications?.new_device !== false,
      appeal_result: prefs.notifications?.appeal_result !== false,
    },
  };
}

export async function getPreferences(userId: string): Promise<IUserPreferences> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.prefs;

  const prefs = withDefaults(await UserPreferences.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, returnDocument: 'after' }
  ).lean() as unknown as IUserPreferences);

  cache.put(userId, { prefs, cachedAt: Date.now() });
  return prefs;
}

export async function updatePreferences(
  userId: string,
  input: Partial<Omit<IUserPreferences, 'userId'>>
): Promise<IUserPreferences> {
  // Flatten nested notifications input to dot-notation for safe partial update
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'notifications' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        $set[`notifications.${k}`] = v;
      }
    } else {
      $set[key] = value;
    }
  }

  const updated = withDefaults(await UserPreferences.findOneAndUpdate(
    { userId },
    { $set, $setOnInsert: { userId } },
    { upsert: true, returnDocument: 'after' }
  ).lean() as unknown as IUserPreferences);

  cache.put(userId, { prefs: updated, cachedAt: Date.now() });
  return updated;
}

export function invalidatePreferences(userId: string): void {
  cache.delete(userId);
}
