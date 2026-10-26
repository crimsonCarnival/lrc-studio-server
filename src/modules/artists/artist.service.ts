import mongoose from 'mongoose';
import Artist from './artist.model.js';
import Project from '../projects/project.model.js';
import { ARTIST_LIMITS, parseArtists, type ArtistCredit } from '../../utils/artists.js';

export const SUGGESTION_MAX_LIMIT = 20;
export const SUGGESTION_DEFAULT_LIMIT = 10;
const MAX_PREFIX_LENGTH = 100;

export const artistKey = (name: string): string => name.normalize('NFC').toLowerCase();

export type StoredCredit = ArtistCredit & { artistId?: mongoose.Types.ObjectId | null };

/**
 * Gives every credit without an `artistId` the id of the owner's artist record,
 * creating it on first use. Ids are only ever resolved by name inside `userId`'s
 * own scope, so an id a client sends can never point at someone else's record.
 */
export async function linkArtistIds(userId: string | mongoose.Types.ObjectId, credits: StoredCredit[]): Promise<void> {
  const owner = new mongoose.Types.ObjectId(String(userId));
  await Promise.all(
    credits.filter((c) => !c.artistId).map(async (credit) => {
      const nameLower = artistKey(credit.name);
      const doc = await Artist.findOneAndUpdate(
        { userId: owner, nameLower },
        { $setOnInsert: { userId: owner, name: credit.name, nameLower } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).select('_id');
      credit.artistId = doc._id;
    }),
  );
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ArtistSuggestionPage {
  items: { id: string; name: string }[];
  total: number;
}

/** Users whose project credits have already been copied into their artist records, per process. */
const syncedFromProjects = new Set<string>();

/**
 * Makes sure every artist named on the user's own projects has an artist record.
 * Records are only written when a project is saved with credits, so projects from
 * before that (a legacy `songArtist` string, or credits never re-saved) were
 * invisible to the suggestions. Runs once per user per process; the upserts are
 * idempotent, so another instance repeating it is harmless.
 */
export async function syncArtistsFromProjects(userId: string): Promise<void> {
  if (syncedFromProjects.has(userId)) return;
  const owner = new mongoose.Types.ObjectId(userId);
  const rows = await Project.find({
    userId: owner,
    $or: [{ 'metadata.artists.0': { $exists: true } }, { 'metadata.songArtist': { $nin: ['', null] } }],
  })
    .select('metadata.artists metadata.songArtist')
    .lean<{ metadata?: { artists?: { name?: string }[] | null; songArtist?: string | null } | null }[]>();

  const names = new Map<string, string>();
  const add = (raw: string | null | undefined): void => {
    const name = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > ARTIST_LIMITS.maxNameLength) return;
    const key = artistKey(name);
    if (!names.has(key)) names.set(key, name);
  };
  for (const row of rows) {
    const credits = row.metadata?.artists ?? [];
    if (credits.length > 0) { credits.forEach((c) => add(c.name)); continue; }
    // Legacy display string: split it only when the parser is sure (no flags);
    // otherwise keep it whole, so "Simon & Garfunkel" is not suggested as two acts.
    const text = row.metadata?.songArtist ?? '';
    const parsed = parseArtists(text);
    if (parsed.flags.length === 0 && parsed.credits.length > 0) parsed.credits.forEach((c) => add(c.name));
    else add(text);
  }

  if (names.size > 0) {
    await Artist.bulkWrite(
      [...names].map(([nameLower, name]) => ({
        updateOne: {
          filter: { userId: owner, nameLower },
          update: { $setOnInsert: { userId: owner, name, nameLower } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  syncedFromProjects.add(userId);
}

/** Test hook: forget which users were synced. */
export function resetArtistSyncCache(): void {
  syncedFromProjects.clear();
}

/**
 * Prefix suggestions from the caller's own artists, nothing else. `userId` comes
 * from the authenticated context only; there is no way to name another user.
 */
export async function suggestArtists(
  userId: string,
  prefix: string,
  limit = SUGGESTION_DEFAULT_LIMIT,
  offset = 0,
): Promise<ArtistSuggestionPage> {
  // Best effort: a failed sync must not take the suggestions down with it.
  await syncArtistsFromProjects(userId).catch(() => {});
  const p = artistKey(prefix.trim().slice(0, MAX_PREFIX_LENGTH));
  const filter = {
    userId: new mongoose.Types.ObjectId(userId),
    ...(p ? { nameLower: { $regex: `^${escapeRegex(p)}` } } : {}),
  };
  const take = Math.min(Math.max(1, Math.trunc(limit) || SUGGESTION_DEFAULT_LIMIT), SUGGESTION_MAX_LIMIT);
  const skip = Math.max(0, Math.trunc(offset) || 0);
  const [rows, total] = await Promise.all([
    Artist.find(filter).sort({ nameLower: 1 }).skip(skip).limit(take).select('name').lean<{ _id: mongoose.Types.ObjectId; name: string }[]>(),
    Artist.countDocuments(filter),
  ]);
  return { items: rows.map((r) => ({ id: String(r._id), name: r.name })), total };
}
