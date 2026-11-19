import CatalogAlbum from './catalog-album.model.js';
import CatalogAlbumDismissal from './catalog-album-dismissal.model.js';
import { assignAlbumSlug } from './catalog.slug.js';
import { albumKey, oid, cleanCatalogText } from './catalog.service.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { listPublicSongsByArtist, isPrimaryOf } from './catalog.query.service.js';
import type { ICatalogArtist } from './catalog-artist.model.js';

type SongRow = {
  metadata?: { songAlbum?: string | null; songYear?: string | number | null; artists?: Array<{ name?: string | null; role?: string | null }> | null } | null;
};

/**
 * Creates approved catalog albums for the album names found on an artist's public songs.
 * Existing albums (any status) and dismissed titles are left alone, so re-running is safe and
 * neither a rejected album nor a dismissed title is resurrected. Returns how many were created.
 */
export async function importAlbumsFromSongs(artist: Pick<ICatalogArtist, '_id' | 'name' | 'nameKey'>, actorId: string): Promise<number> {
  // Primary credits only: a song this artist is merely featured on belongs to someone else's album.
  const songs = ((await listPublicSongsByArtist(artist.name)) as unknown as SongRow[]).filter((s) => isPrimaryOf(s, artist.nameKey));
  // Same title/key derivation as admin create, Detect albums and dismissals (see cleanCatalogText).
  // Over-long titles are skipped, as cleanName rejects them: truncating would change the key.
  const groups = new Map<string, { title: string; years: string[] }>();
  for (const song of songs) {
    const title = cleanCatalogText(String(song.metadata?.songAlbum ?? ''));
    if (!title || title.length > CATALOG_LIMITS.maxAlbumTitle) continue;
    const key = albumKey(title);
    const year = String(song.metadata?.songYear ?? '').trim();
    const g = groups.get(key) ?? { title, years: [] };
    if (/^\d{4}$/.test(year)) g.years.push(year);
    groups.set(key, g);
  }
  if (groups.size === 0) return 0;

  // Skip albums that already exist (any status) and titles an admin dismissed in Detect albums,
  // so neither a rejection nor a dismissal is undone by an import.
  const keys = { $in: [...groups.keys()] };
  const [albums, dismissals] = await Promise.all([
    CatalogAlbum.find({ artistId: artist._id, titleKey: keys }).select('titleKey').lean<{ titleKey: string }[]>(),
    CatalogAlbumDismissal.find({ artistId: artist._id, titleKey: keys }).select('titleKey').lean<{ titleKey: string }[]>(),
  ]);
  const existing = new Set([...albums, ...dismissals].map((a) => a.titleKey));
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
