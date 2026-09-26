import type { LyricsResult } from './lyrics-provider.types.js';

/**
 * lyrics.ovh — free, keyless, plain-text-only lyrics API.
 *
 * Sits after LyricFind in the chain: it needs no credentials, so it is the
 * provider that actually answers on an unlicensed deployment, but it returns
 * no timestamps and has no fuzzy matching (artist and title must both be close
 * to exact), so it can never replace LRCLIB as the primary.
 *
 * Verified live 2026-09-25: GET /v1/{artist}/{title} → { lyrics }, or 404 with
 * { error: 'No lyrics found' } on a miss.
 */
const BASE_URL = 'https://api.lyrics.ovh/v1';
const FETCH_TIMEOUT_MS = 8000;

/**
 * Some records are stored with a French catalogue header prepended by the
 * upstream scrape. It is never part of the lyric, so strip it.
 */
const CATALOGUE_HEADER = /^paroles de la chanson .*?\n+/i;

export async function getLyricsFromLyricsOvh(track: string, artist: string): Promise<LyricsResult | null> {
  // Both halves of the path are required — this provider has no search.
  if (!track || !artist) return null;

  const url = `${BASE_URL}/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lyricsovh_http_${res.status}`);

  const data = await res.json().catch(() => null) as { lyrics?: string; error?: string } | null;
  if (!data || data.error) return null;

  const lyrics = (data.lyrics ?? '').replace(CATALOGUE_HEADER, '').trim();
  if (!lyrics) return null;

  return { lyrics, synced: false, provider: 'lyricsovh' };
}
