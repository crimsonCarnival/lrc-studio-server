import { LRUCache } from '@crimson-carnival/ds-js';
import UserPreferences, { type IUserPreferences } from '../../db/user-preferences.model.js';

// Cache 1000 most-recently-accessed preference docs
const cache = new LRUCache<string, IUserPreferences>(1000);

export async function getPreferences(userId: string): Promise<IUserPreferences> {
  const cached = cache.get(userId);
  if (cached) return cached;

  const prefs = await UserPreferences.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, new: true }
  ).lean() as unknown as IUserPreferences;

  cache.put(userId, prefs);
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

  const updated = await UserPreferences.findOneAndUpdate(
    { userId },
    { $set, $setOnInsert: { userId } },
    { upsert: true, new: true }
  ).lean() as unknown as IUserPreferences;

  cache.put(userId, updated);
  return updated;
}

export function invalidatePreferences(userId: string): void {
  cache.delete(userId);
}
