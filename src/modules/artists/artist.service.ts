import mongoose from 'mongoose';
import Artist from '../../db/artist.model.js';
import type { ArtistCredit } from '../../utils/artists.js';

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
        { upsert: true, new: true, setDefaultsOnInsert: true },
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
