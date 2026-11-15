import type mongoose from 'mongoose';
import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { slugify } from '../../utils/project-slug.js';

const MAX_TRIES = 50;
const DUPLICATE_KEY = 11000;

type SlugTarget = {
  /** Writes `slug` only while the document's slug is still null. */
  setIfUnset: (slug: string) => Promise<void>;
  read: () => Promise<string | null | undefined>;
};

const isDuplicateKey = (e: unknown): boolean => (e as { code?: number } | null)?.code === DUPLICATE_KEY;

async function assignSlug(base: string, target: SlugTarget): Promise<string> {
  // A slug never changes once set: return the stored one instead of retrying.
  const existing = await target.read();
  if (existing) return existing;
  for (let n = 1; n <= MAX_TRIES; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    try {
      await target.setIfUnset(candidate);
    } catch (e) {
      if (isDuplicateKey(e)) continue; // taken on the unique partial index
      throw e;
    }
    // Under a race another caller may have set it first; the stored value wins.
    const stored = await target.read();
    if (stored) return stored;
  }
  throw new Error(`Could not assign a unique slug for "${base}" after ${MAX_TRIES} attempts`);
}

const idSuffix = (id: mongoose.Types.ObjectId): string => id.toString().slice(-6);

export function assignArtistSlug(artistId: mongoose.Types.ObjectId, name: string): Promise<string> {
  const base = slugify(name) || `artist-${idSuffix(artistId)}`;
  return assignSlug(base, {
    setIfUnset: async (slug) => {
      await CatalogArtist.updateOne({ _id: artistId, slug: null }, { $set: { slug } });
    },
    read: async () => (await CatalogArtist.findById(artistId, { slug: 1 }).lean())?.slug,
  });
}

export function assignAlbumSlug(
  albumId: mongoose.Types.ObjectId,
  artistId: mongoose.Types.ObjectId,
  title: string
): Promise<string> {
  const base = slugify(title) || `album-${idSuffix(albumId)}`;
  return assignSlug(base, {
    // artistId in the filter keeps the write scoped to the right artist's index.
    setIfUnset: async (slug) => {
      await CatalogAlbum.updateOne({ _id: albumId, artistId, slug: null }, { $set: { slug } });
    },
    read: async () => (await CatalogAlbum.findById(albumId, { slug: 1 }).lean())?.slug,
  });
}
