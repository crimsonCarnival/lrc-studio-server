import { getEnv } from '../../config/env.js';
import type { LyricsResult, LyricsSearchHit } from './lyrics-provider.types.js';

/**
 * LRCLIB (https://lrclib.net) — free, keyless, crowdsourced lyrics library.
 *
 * Primary provider because it is the only source in the chain that returns
 * *already-synchronized* LRC. When it hits, the user skips both manual syncing
 * and the ASR round-trip entirely.
 *
 * No API key and no registration. LRCLIB asks only that clients identify
 * themselves via User-Agent with an app name and a contact link, which is what
 * `userAgent()` builds. Verified live 2026-09-25: `/api/get` and `/api/search`
 * return { id, trackName, artistName, albumName, duration, instrumental,
 * hasWordSync, plainLyrics, syncedLyrics }; a miss on `/api/get` is a 404 with
 * { name: 'TrackNotFound' }.
 */
const BASE_URL = 'https://lrclib.net/api';
const FETCH_TIMEOUT_MS = 8000;
const SEARCH_PAGE_SIZE = 8;

/** Bumped by hand — LRCLIB only uses this to contact operators about misbehaving clients. */
const CLIENT_VERSION = '1.0';

export const LRCLIB_ID_PREFIX = 'lrclib:';

type LrclibRecord = {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

function userAgent(): string {
  return `LRCStudio/${CLIENT_VERSION} (${getEnv().APP_URL})`;
}

async function lrclibFetch<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // A miss is an ordinary outcome here, not an error — the chain falls through
  // to the next provider. Only genuine upstream faults throw.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib_http_${res.status}`);
  return await res.json() as T;
}

/** A record is only useful to us if it actually carries text. Instrumentals never do. */
function hasLyrics(rec: LrclibRecord): boolean {
  if (rec.instrumental) return false;
  return !!(rec.syncedLyrics?.trim() || rec.plainLyrics?.trim());
}

function toResult(rec: LrclibRecord): LyricsResult | null {
  const synced = rec.syncedLyrics?.trim();
  if (synced) return { lyrics: synced, synced: true, provider: 'lrclib' };
  const plain = rec.plainLyrics?.trim();
  if (plain) return { lyrics: plain, synced: false, provider: 'lrclib' };
  return null;
}

/**
 * Picks the best record from a search page: prefer synced over plain, then the
 * closest duration to `durationSec` when we know it. Duration is the strongest
 * disambiguator LRCLIB gives us for covers, live versions, and remasters.
 */
function pickBest(records: LrclibRecord[], durationSec?: number): LrclibRecord | null {
  const usable = records.filter(hasLyrics);
  if (!usable.length) return null;

  const score = (rec: LrclibRecord): number => {
    let s = rec.syncedLyrics?.trim() ? 1000 : 0;
    if (durationSec && rec.duration) {
      // Within ~2s is effectively an exact match; penalise linearly past that.
      s -= Math.abs(rec.duration - durationSec);
    }
    return s;
  };

  return usable.reduce((best, rec) => (score(rec) > score(best) ? rec : best));
}

/** Fetch one record by its LRCLIB id (from a prior search hit) — the exact-match path. */
export async function getLrclibById(id: number): Promise<LyricsResult | null> {
  const rec = await lrclibFetch<LrclibRecord>(`/get/${id}`);
  if (!rec || !hasLyrics(rec)) return null;
  return toResult(rec);
}

/**
 * Look up lyrics by track signature. Tries the exact-signature endpoint first
 * when a duration is known (LRCLIB requires duration there), then falls back to
 * fuzzy search. Returns null when LRCLIB simply has no match.
 */
export async function getLyricsFromLrclib(
  track: string,
  artist: string,
  album?: string,
  durationSec?: number,
): Promise<LyricsResult | null> {
  if (durationSec && artist) {
    const params = new URLSearchParams({
      track_name: track,
      artist_name: artist,
      duration: String(Math.round(durationSec)),
    });
    if (album) params.set('album_name', album);
    const exact = await lrclibFetch<LrclibRecord>(`/get?${params}`);
    if (exact && hasLyrics(exact)) return toResult(exact);
  }

  const params = new URLSearchParams({ track_name: track });
  if (artist) params.set('artist_name', artist);
  const records = await lrclibFetch<LrclibRecord[]>(`/search?${params}`);
  if (!Array.isArray(records) || !records.length) return null;

  const best = pickBest(records, durationSec);
  return best ? toResult(best) : null;
}

/**
 * Free-text search. Used as the search fallback when Genius is unconfigured, so
 * the lyrics search feature works with zero API keys.
 *
 * LRCLIB returns the lyrics inline with each hit, which lets us flag which
 * results are time-synced *before* the user picks one.
 */
export async function searchLrclib(query: string): Promise<LyricsSearchHit[]> {
  const records = await lrclibFetch<LrclibRecord[]>(`/search?q=${encodeURIComponent(query)}`);
  if (!Array.isArray(records)) return [];

  return records
    .filter(hasLyrics)
    .slice(0, SEARCH_PAGE_SIZE)
    .map(rec => ({
      id: `${LRCLIB_ID_PREFIX}${rec.id}`,
      title: rec.trackName,
      artist: rec.artistName,
      album: rec.albumName,
      duration: rec.duration,
      synced: !!rec.syncedLyrics?.trim(),
      thumbnail: null,
      url: null,
      provider: 'lrclib' as const,
    }));
}
