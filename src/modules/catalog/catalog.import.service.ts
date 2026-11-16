import CatalogAlbum from './catalog-album.model.js';
import { assignAlbumSlug } from './catalog.slug.js';
import { albumKey, oid } from './catalog.service.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { listPublicSongsByArtist } from './catalog.query.service.js';
import type { ICatalogArtist } from './catalog-artist.model.js';

type SongRow = {
  metadata?: { songAlbum?: string | null; songYear?: string | number | null; } | null;
};

/**
 * Creates approved catalog albums for the album names found on an artist's public songs.
 * Existing albums (any status) with the same title are left alone, so re-running is safe and
 * a rejected album is never resurrected. Returns how many were created.
 */
export async function importAlbumsFromSongs(artist: Pick<ICatalogArtist, '_id' | 'name'>, actorId: string): Promise<number> {
  const songs = (await listPublicSongsByArtist(artist.name)) as unknown as SongRow[];
  const groups = new Map<string, { title: string; years: string[] }>();
  for (const song of songs) {
    const title = (song.metadata?.songAlbum ?? '').trim().slice(0, CATALOG_LIMITS.maxAlbumTitle);
    if (!title) continue;
    const key = albumKey(title);
    const year = String(song.metadata?.songYear ?? '').trim();
    const g = groups.get(key) ?? { title, years: [] };
    if (/^\d{4}$/.test(year)) g.years.push(year);
    groups.set(key, g);
  }
  if (groups.size === 0) return 0;

  const existing = new Set(
    (await CatalogAlbum.find({ artistId: artist._id, titleKey: { $in: [...groups.keys()] } }).select('titleKey').lean<{ titleKey: string }[]>())
      .map((a) => a.titleKey),
  );
  let created = 0;
  for (const [titleKey, g] of groups) {
    if (existing.has(titleKey)) continue;
    const album = await CatalogAlbum.create({
      artistId: artist._id,
      title: g.title,
      titleKey,
      year: g.years.sort().at(-1) ?? null,
      // Song covers are user uploads, not catalog-hosted images, so they are not copied; the page falls back to a song cover.
      coverUrl: null,
      slug: null,
      status: 'approved',
      source: 'admin',
      submittedBy: oid(actorId),
      reviewedBy: oid(actorId),
      reviewedAt: new Date(),
    });
    await assignAlbumSlug(album._id, artist._id, g.title);
    created += 1;
  }
  return created;
}
