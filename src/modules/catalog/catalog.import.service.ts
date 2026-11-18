import CatalogAlbum from './catalog-album.model.js';
import CatalogAlbumDismissal from './catalog-album-dismissal.model.js';
import { assignAlbumSlug } from './catalog.slug.js';
import { albumKey, oid, squash } from './catalog.service.js';
import { stripHtml } from '../../utils/sanitize.js';
import { CATALOG_LIMITS } from './catalog.limits.js';
import { listPublicSongsByArtist } from './catalog.query.service.js';
import type { ICatalogArtist } from './catalog-artist.model.js';

type SongRow = {
  metadata?: { songAlbum?: string | null; songYear?: string | number | null; } | null;
};

/**
 * Creates approved catalog albums for the album names found on an artist's public songs.
 * Existing albums (any status) and dismissed titles are left alone, so re-running is safe and
 * neither a rejected album nor a dismissed title is resurrected. Returns how many were created.
 */
export async function importAlbumsFromSongs(artist: Pick<ICatalogArtist, '_id' | 'name'>, actorId: string): Promise<number> {
  const songs = (await listPublicSongsByArtist(artist.name)) as unknown as SongRow[];
  // Grouped by the key Detect albums derives (and dismissals store): albumKey(squash(raw)).
  // The stored title is cleaned the way admin-created albums are; its key (`titleKey`) can
  // differ from the detect key when the raw value carries markup, so both are checked below.
  const groups = new Map<string, { title: string; titleKey: string; years: string[] }>();
  for (const song of songs) {
    const raw = String(song.metadata?.songAlbum ?? '');
    const detectKey = albumKey(squash(raw));
    const title = squash(stripHtml(raw)).normalize('NFC').slice(0, CATALOG_LIMITS.maxAlbumTitle);
    if (!detectKey || !title) continue;
    const year = String(song.metadata?.songYear ?? '').trim();
    const g = groups.get(detectKey) ?? { title, titleKey: albumKey(title), years: [] };
    if (/^\d{4}$/.test(year)) g.years.push(year);
    groups.set(detectKey, g);
  }
  if (groups.size === 0) return 0;

  // Skip albums that already exist (any status) and titles an admin dismissed in Detect albums,
  // so neither a rejection nor a dismissal is undone by an import.
  const keys = { $in: [...new Set([...groups.keys(), ...[...groups.values()].map((g) => g.titleKey)])] };
  const [albums, dismissals] = await Promise.all([
    CatalogAlbum.find({ artistId: artist._id, titleKey: keys }).select('titleKey').lean<{ titleKey: string }[]>(),
    CatalogAlbumDismissal.find({ artistId: artist._id, titleKey: keys }).select('titleKey').lean<{ titleKey: string }[]>(),
  ]);
  const existing = new Set([...albums, ...dismissals].map((a) => a.titleKey));
  let created = 0;
  for (const [detectKey, g] of groups) {
    const { titleKey } = g;
    if (existing.has(detectKey) || existing.has(titleKey)) continue;
    existing.add(titleKey); // two detect keys can clean to the same title

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
