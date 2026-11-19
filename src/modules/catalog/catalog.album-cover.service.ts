import CatalogArtist from './catalog-artist.model.js';
import { fail, isError, validId, albumKey, cleanCatalogText, type CatalogError } from './catalog.service.js';
import { assertManager } from './catalog.admin.service.js';
import { isPrimaryOf, listPublicSongsByArtist, songAlbumKey } from './catalog.query.service.js';
import { storeRemoteImage } from './catalog.genius.service.js';

const MAX_PROPOSALS = 5;

export type ProjectCoverProposal = { publicId: string; title: string; coverUrl: string };

type SongDoc = {
  publicId?: string;
  title?: string;
  coverImage?: string | null;
  metadata?: { songAlbum?: string | null; artists?: Array<{ name?: string | null; role?: string | null }> | null } | null;
};

/** An image in our own Cloudinary cloud: https, exact host, our cloud's path, no credentials/port/query. */
export function isOwnCloudinaryUrl(url: unknown): url is string {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || typeof url !== 'string' || url.length === 0 || url.length > 2000) return false;
  try {
    const u = new URL(url);
    if (u.href !== url || u.protocol !== 'https:' || u.host !== 'res.cloudinary.com') return false;
    if (u.username || u.password || u.port || u.search || u.hash) return false;
    return u.pathname.startsWith(`/${cloud}/image/upload/`);
  } catch {
    return false;
  }
}

const notFoundProposal = (): CatalogError => fail(404, 'CATALOG_COVER_PROPOSAL_NOT_FOUND', 'That cover is no longer available');

/**
 * Covers of public songs that credit the artist as primary and name this album, with the same album
 * key the catalog uses (`songAlbumKey`). Only covers already in our own Cloudinary cloud qualify, so
 * the later copy never fetches a host the project's owner chose.
 */
async function findProposals(artistId: string, title: string): Promise<ProjectCoverProposal[] | CatalogError> {
  if (!validId(artistId)) return notFoundProposal();
  const artist = await CatalogArtist.findById(artistId).select('name nameKey').lean<{ name: string; nameKey: string } | null>();
  if (!artist) return notFoundProposal();
  const wanted = albumKey(cleanCatalogText(title));
  if (!wanted) return [];

  const songs = (await listPublicSongsByArtist(artist.name)) as unknown as SongDoc[];
  const seen = new Set<string>();
  const out: ProjectCoverProposal[] = [];
  for (const song of songs) {
    if (!song.publicId || !isPrimaryOf(song, artist.nameKey) || songAlbumKey(song) !== wanted) continue;
    if (!isOwnCloudinaryUrl(song.coverImage) || seen.has(song.coverImage)) continue;
    seen.add(song.coverImage);
    out.push({ publicId: song.publicId, title: song.title ?? '', coverUrl: song.coverImage });
    if (out.length === MAX_PROPOSALS) break;
  }
  return out;
}

export async function listProjectCoverProposals(adminId: string, artistId: string, title: string): Promise<ProjectCoverProposal[] | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  return findProposals(artistId, title);
}

/**
 * Copies a proposed project cover into the admin's catalog folder. The cover is re-resolved from the
 * proposals (never taken from the client), so only a cover that would have been offered can be copied.
 */
export async function copyProjectCover(adminId: string, artistId: string, title: string, publicId: string): Promise<{ imageUrl: string } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  const proposals = await findProposals(artistId, title);
  if (isError(proposals)) return proposals;
  const hit = proposals.find((p) => p.publicId === publicId);
  if (!hit) return notFoundProposal();
  const stored = await storeRemoteImage(hit.coverUrl, adminId);
  return isError(stored) ? stored : { imageUrl: stored };
}
