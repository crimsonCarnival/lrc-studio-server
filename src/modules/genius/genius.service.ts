import * as cheerio from 'cheerio';
import { getEnv } from '../../config/env.js';

const GENIUS_API_BASE = 'https://api.genius.com';

export interface GeniusSong {
  id: number;
  title: string;
  artist: string;
  thumbnail: string;
  url: string;
}

export async function searchSongs(query: string): Promise<GeniusSong[]> {
  const token = getEnv().GENIUS_CLIENT_ACCESS_TOKEN;
  if (!token) throw new Error('genius_not_configured');

  const params = new URLSearchParams({ q: query });
  const response = await fetch(`${GENIUS_API_BASE}/search?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') ?? '60';
    const err = new Error('rate_limited') as Error & { retryAfter: string };
    err.retryAfter = retryAfter;
    throw err;
  }

  if (!response.ok) throw new Error('upstream_error');

  const data = await response.json() as {
    response: {
      hits: Array<{
        result: {
          id: number;
          title: string;
          primary_artist: { name: string };
          header_image_url: string;
          url: string;
        };
      }>;
    };
  };

  return data.response.hits.map(hit => ({
    id: hit.result.id,
    title: hit.result.title,
    artist: hit.result.primary_artist.name,
    thumbnail: hit.result.header_image_url,
    url: hit.result.url,
  }));
}

export async function extractLyrics(url: string): Promise<string> {
  // SSRF guard: only fetch from genius.com
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith('genius.com')) {
    throw new Error('invalid_url');
  }

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) throw new Error('upstream_error');

  const html = await response.text();
  const $ = cheerio.load(html);

  // Primary selector, fallback if Genius restructures their page
  let containers = $('[data-lyrics-container="true"]');
  if (!containers.length) {
    containers = $('[class*="Lyrics__Container"]');
  }
  if (!containers.length) {
    throw new Error('lyrics_unavailable');
  }

  const lines: string[] = [];

  containers.each((_, el) => {
    // Remove non-lyric blocks: Genius embeds annotation previews and song
    // descriptions as <div> children in the server-rendered HTML, which JS
    // replaces client-side. Actual lyric content only uses <p>, <a>, <br>.
    $(el).find('div').remove();
    // Replace <br> with newline placeholder before stripping tags
    $(el).find('br').replaceWith('\n');
    const raw = $(el).text();
    lines.push(raw);
  });

  const combined = lines.join('\n');

  return combined
    .replace(/\[.*?\]/g, '')                    // remove [Chorus], [Verse 1], etc.
    .replace(/\r\n/g, '\n')
    .replace(/^\d+\s*Contributors?[^\n]*/gim, '') // strip "34 Contributors..." metadata
    .replace(/^Translations?[^\n]*/gim, '')        // strip "Translations..." lines
    .replace(/^.+\s+Lyrics\s*$/gim, '')            // strip "Song Title Lyrics" header
    .replace(/\n{3,}/g, '\n\n')                    // collapse excessive blank lines
    .trim();
}
