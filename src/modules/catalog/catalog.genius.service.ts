import { searchSong, getArtist } from '../genius/genius.client.js';
import { readCappedBody, CappedBodyError } from '../../utils/read-capped-body.js';
import { uploadCatalogImageBuffer } from '../uploads/uploads.service.js';
import { fail, type CatalogError } from './catalog.service.js';
import { artistKey } from '../artists/artist.service.js';
import { assertManager, isGeniusPageUrl } from './catalog.admin.service.js';

export const GENIUS_IMAGE_HOSTS = ['images.genius.com', 'filepicker-images.genius.com', 'assets.genius.com'] as const;

const MAX_MATCHES = 5;
const RASTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A usable Genius artist photo: https, exact allow-listed host, no credentials/port, not the default placeholder. */
export function isGeniusImageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const u = new URL(url);
    if (u.href !== url || u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (!(GENIUS_IMAGE_HOSTS as readonly string[]).includes(u.hostname)) return false;
    return !(u.hostname === 'assets.genius.com' && u.pathname.toLowerCase().startsWith('/images/default_'));
  } catch {
    return false;
  }
}

export type GeniusArtistMatch = { geniusId: number; name: string; imageUrl: string; url: string };
type GeniusMatchCandidate = GeniusArtistMatch;

/** Up to 5 distinct Genius artists with a usable photo; null when Genius is unconfigured. */
export async function searchGeniusArtists(adminId: string, q: string): Promise<GeniusArtistMatch[] | null | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;
  const hits = await searchSong(q);
  if (!hits) return null;

  const seen = new Set<number>();
  const artists: GeniusMatchCandidate[] = [];
  for (const { primary_artist: a } of hits) {
    if (!a || !Number.isInteger(a.id) || typeof a.name !== 'string') continue;
    if (!isGeniusPageUrl(a.url) || !isGeniusImageUrl(a.image_url)) continue;
    if (seen.has(a.id as number)) continue;
    seen.add(a.id as number);
    artists.push({ geniusId: a.id as number, name: a.name, imageUrl: a.image_url, url: a.url });
  }

  const want = artistKey(q.trim());
  const exact = artists.filter((a) => artistKey(a.name) === want);
  const rest = artists.filter((a) => artistKey(a.name) !== want);
  return [...exact, ...rest].slice(0, MAX_MATCHES);
}

const upstream = (): CatalogError => fail(502, 'CATALOG_GENIUS_UPSTREAM', 'Genius is unavailable right now');
const rejected = (): CatalogError => fail(422, 'CATALOG_GENIUS_IMAGE_REJECTED', 'That Genius photo cannot be used');

/**
 * Copies a Genius artist's photo into the admin's catalog folder. The image URL is never taken from the
 * client: the artist is re-resolved from the Genius API and only an allow-listed image host is fetched.
 * Errors are opaque codes; upstream text and the token never reach the message.
 */
export async function copyGeniusArtistPhoto(adminId: string, geniusId: number): Promise<{ imageUrl: string; sourceUrl: string } | CatalogError> {
  const denied = await assertManager(adminId);
  if (denied) return denied;

  let artist: Awaited<ReturnType<typeof getArtist>>;
  try {
    artist = await getArtist(geniusId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'genius_unauthorized') return fail(503, 'CATALOG_GENIUS_UNAVAILABLE', 'Genius is not configured');
    if (msg === 'genius_not_found' || msg === 'genius_invalid_id') return fail(404, 'CATALOG_GENIUS_NOT_FOUND', 'Genius artist not found');
    return upstream();
  }
  if (!artist) return fail(503, 'CATALOG_GENIUS_UNAVAILABLE', 'Genius is not configured');
  if (!isGeniusImageUrl(artist.image_url) || !isGeniusPageUrl(artist.url)) return rejected();

  let res: Response;
  try {
    res = await fetch(artist.image_url, { redirect: 'error', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  } catch {
    return upstream();
  }
  if (!res.ok) return upstream();

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!RASTER_TYPES.has(contentType)) return rejected();
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_IMAGE_BYTES) return rejected();

  let data: Buffer;
  try {
    data = await readCappedBody(res, MAX_IMAGE_BYTES);
  } catch (err) {
    return err instanceof CappedBodyError ? rejected() : upstream();
  }

  try {
    return { imageUrl: await uploadCatalogImageBuffer(data, contentType, adminId), sourceUrl: artist.url };
  } catch (err) {
    return err instanceof Error && err.message === 'storage_unconfigured'
      ? fail(503, 'CATALOG_GENIUS_UNAVAILABLE', 'Image storage is not configured')
      : upstream();
  }
}
