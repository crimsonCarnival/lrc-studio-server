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

