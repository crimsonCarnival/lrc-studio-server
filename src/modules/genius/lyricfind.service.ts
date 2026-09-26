import { getEnv } from '../../config/env.js';
import type { LyricsResult } from './lyrics-provider.types.js';

/**
 * LyricFind — licensed commercial lyrics API, used as the fallback when LRCLIB
 * has no match.
 *
 * Unlike LRCLIB this is NOT keyless: LyricFind issues credentials under a
 * commercial agreement and publishes no open documentation. The whole provider
 * is therefore gated on `LYRICFIND_API_KEY` and is a silent no-op (returns
 * null, chain continues) when unset, so an unlicensed deployment pays nothing
 * and logs nothing.
 *
 * ⚠ The request/response shape below follows LyricFind's documented
 * `lyric.do` interface but has NOT been verified against a live key. Confirm
 * `trackid` formatting and the response field names against the contract docs
 * when credentials arrive — `parseLyrics` is deliberately narrow so a mismatch
 * surfaces as a clean null (chain falls through) rather than as bad text.
 */
const BASE_URL = 'https://api.lyricfind.com/lyric.do';
const FETCH_TIMEOUT_MS = 8000;

/** LRC timestamp at the start of a line: `[mm:ss.xx]`. */
const LRC_LINE = /^\s*\[\d{1,2}:\d{2}([.:]\d{1,3})?\]/m;

export function isLyricFindConfigured(): boolean {
  return !!getEnv().LYRICFIND_API_KEY;
}

type LyricFindResponse = {
  response?: { code?: number; description?: string };
  track?: { lyrics?: string; instrumental?: boolean; viewable?: boolean };
};

function parseLyrics(data: LyricFindResponse): string | null {
  const track = data.track;
  if (!track || track.instrumental) return null;
  // `viewable: false` means the territory/licence does not permit display.
  if (track.viewable === false) return null;
  const lyrics = track.lyrics?.trim();
  return lyrics ? lyrics : null;
}

/**
 * Look up lyrics by track + artist. Returns null on any miss (no match, not
 * licensed for this territory, instrumental, or unconfigured) so the caller can
 * fall through to the next provider. Only genuine upstream faults throw.
 *
 * Requests LRC format: LyricFind serves timestamped lyrics to licensees that
 * have them, and we detect what actually came back rather than trusting a flag.
 */
export async function getLyricsFromLyricFind(track: string, artist: string): Promise<LyricsResult | null> {
  const env = getEnv();
  if (!env.LYRICFIND_API_KEY) return null;
  if (!track || !artist) return null;

  const params = new URLSearchParams({
    apikey: env.LYRICFIND_API_KEY,
    reqtype: 'default',
    territory: env.LYRICFIND_TERRITORY ?? 'US',
    trackid: `artistname:${artist},trackname:${track}`,
    format: 'lrc',
    output: 'json',
  });

  const res = await fetch(`${BASE_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error('lyricfind_unauthorized');
  if (!res.ok) throw new Error(`lyricfind_http_${res.status}`);

  const data = await res.json().catch(() => null) as LyricFindResponse | null;
  if (!data) return null;
  // Non-zero response code is LyricFind's own "no result / not permitted".
  if (data.response?.code !== undefined && data.response.code !== 0) return null;

  const lyrics = parseLyrics(data);
  if (!lyrics) return null;

  return { lyrics, synced: LRC_LINE.test(lyrics), provider: 'lyricfind' };
}
