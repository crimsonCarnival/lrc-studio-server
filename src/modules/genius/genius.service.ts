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

function cleanLyrics(raw: string): string {
  return raw
    .replace(/\[.*?\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\d+\s*Contributors?[^\n]*/gim, '')
    .replace(/^Translations?[^\n]*/gim, '')
    .replace(/^.+\s+Lyrics\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractFromPreloadedState(html: string): string | null {
  // Genius embeds lyrics as serialized JSON in window.__PRELOADED_STATE__
  const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*JSON\.parse\('([\s\S]*?)'\)/);
  if (!match) return null;

  try {
    // Genius escapes single quotes as \\'  inside the JSON.parse argument
    const jsonStr = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const state = JSON.parse(jsonStr) as Record<string, unknown>;

    // Walk the entity map looking for song lyrics text
    const entities = (state as Record<string, unknown>)['entities'] as Record<string, unknown> | undefined;
    const songs = entities?.['songs'] as Record<string, { lyrics?: { plain?: string } }> | undefined;
    if (songs) {
      for (const song of Object.values(songs)) {
        if (song?.lyrics?.plain) return song.lyrics.plain;
      }
    }

    // Alternate path: songPage.lyricsData.body.plain
    const songPage = (state as Record<string, unknown>)['songPage'] as Record<string, unknown> | undefined;
    const plain = (((songPage?.['lyricsData'] as Record<string, unknown>)?.['body'] as Record<string, unknown>)?.['plain']) as string | undefined;
    if (plain) return plain;
  } catch {
    // malformed JSON — fall through to DOM scraping
  }
  return null;
}

function extractFromDom(html: string): string | null {
  const $ = cheerio.load(html);

  let containers = $('[data-lyrics-container="true"]');
  if (!containers.length) containers = $('[class*="Lyrics__Container"]');
  if (!containers.length) return null;

  const lines: string[] = [];
  containers.each((_, el) => {
    $(el).find('div').remove();
    $(el).find('br').replaceWith('\n');
    lines.push($(el).text());
  });
  return lines.join('\n');
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
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  });

  if (!response.ok) {
    throw Object.assign(new Error('upstream_error'), { statusCode: response.status });
  }

  const html = await response.text();

  const raw = extractFromPreloadedState(html) ?? extractFromDom(html);
  if (!raw) throw new Error('lyrics_unavailable');

  return cleanLyrics(raw);
}
