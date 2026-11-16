import CatalogArtist from './catalog-artist.model.js';
import CatalogAlbum from './catalog-album.model.js';
import { validId, oid } from './catalog.service.js';

const QUEUE_CAP = 100;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pending entries, oldest first. Capped so a flood of submissions cannot make the queue unbounded. */
export async function listReviewQueue() {
  const [artists, albums] = await Promise.all([
    CatalogArtist.find({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).limit(QUEUE_CAP).lean(),
    CatalogAlbum.find({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).limit(QUEUE_CAP).lean(),
  ]);
  return { artists, albums };
}

export async function listApprovedArtists(opts: { query?: string | null; offset?: number | null; limit?: number | null }) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 50);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const q = typeof opts.query === 'string' ? opts.query.trim().slice(0, 100) : '';
  const filter = { status: 'approved' as const, ...(q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {}) };
  return CatalogArtist.find(filter).sort({ nameKey: 1, _id: 1 }).skip(offset).limit(limit).lean();
}

export async function listApprovedAlbums(artistId: string) {
  if (!validId(artistId)) return [];
  return CatalogAlbum.find({ artistId: oid(artistId), status: 'approved' }).sort({ year: 1, titleKey: 1, _id: 1 }).lean();
}
