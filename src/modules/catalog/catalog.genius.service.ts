import { searchSong, type GeniusArtist } from '../genius/genius.client.js';
import { artistKey } from '../artists/artist.service.js';
import { isGeniusPageUrl } from './catalog.admin.service.js';

export const GENIUS_IMAGE_HOSTS = ['images.genius.com', 'filepicker-images.genius.com', 'assets.genius.com'] as const;

const MAX_MATCHES = 5;

/** A usable Genius artist photo: https, exact allow-listed host, no credentials/port, not the default placeholder. */
export function isGeniusImageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (!(GENIUS_IMAGE_HOSTS as readonly string[]).includes(u.hostname)) return false;
    return !(u.hostname === 'assets.genius.com' && u.pathname.startsWith('/images/default_'));
  } catch {
    return false;
  }
}

export type GeniusArtistMatch = { geniusId: number; name: string; imageUrl: string; url: string };

/** Up to 5 distinct Genius artists with a usable photo; null when Genius is unconfigured. */
export async function searchGeniusArtists(q: string): Promise<GeniusArtistMatch[] | null> {
  const hits = await searchSong(q);
  if (!hits) return null;

  const seen = new Set<number>();
  const artists: GeniusArtist[] = [];
  for (const { primary_artist: a } of hits) {
    if (a?.id === undefined || seen.has(a.id)) continue;
    seen.add(a.id);
    artists.push(a);
  }

  const want = artistKey(q.trim());
  const exact = artists.filter((a) => artistKey(a.name) === want);
  const rest = artists.filter((a) => artistKey(a.name) !== want);

  return [...exact, ...rest]
    .flatMap((a) =>
      isGeniusPageUrl(a.url) && isGeniusImageUrl(a.image_url)
        ? [{ geniusId: a.id as number, name: a.name, imageUrl: a.image_url, url: a.url }]
        : [],
    )
    .slice(0, MAX_MATCHES);
}
