/**
 * Stable, machine-readable availability codes. The client maps each to an i18n
 * message; never send upstream error text instead of one of these.
 *
 * - available       — playable through the IFrame API
 * - not_found       — doesn't exist, was deleted, or was removed by YouTube
 * - private         — private video
 * - embed_disabled  — owner disabled embedding
 * - age_restricted  — age-gated (embeds require sign-in, so unplayable here); API key only
 * - region_blocked  — blocked in the viewer's country; API key only
 * - restricted      — unplayable, but the exact reason can't be determined (oEmbed 401/403 without an API key)
 *
 * Two more codes exist only at the HTTP layer: `invalid_id` (400) and `check_failed` (502).
 */
export type YoutubeAvailability =
  | 'available'
  | 'not_found'
  | 'private'
  | 'embed_disabled'
  | 'age_restricted'
  | 'region_blocked'
  | 'restricted';

export const YOUTUBE_VIDEO_ID_PATTERN = '^[A-Za-z0-9_-]{11}$';

const CHECK_TIMEOUT_MS = 5000;
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

type VideoItem = {
  id: string;
  status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
  contentDetails?: {
    regionRestriction?: { allowed?: string[]; blocked?: string[] };
    contentRating?: { ytRating?: string };
  };
};

/**
 * videos.list for up to 50 ids. The key travels in the `X-Goog-Api-Key` header, not
 * the query string, so it can't end up in logged URLs or error messages. Returns
 * null when the API is unreachable or errors (quota, bad key, timeout).
 */
async function fetchVideoItems(ids: string[], apiKey: string, parts: string): Promise<Map<string, VideoItem> | null> {
  const params = new URLSearchParams({ part: parts, id: ids.join(','), maxResults: '50' });
  try {
    const res = await fetch(`${VIDEOS_ENDPOINT}?${params.toString()}`, {
      headers: { 'X-Goog-Api-Key': apiKey },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json() as { items?: VideoItem[] };
    return new Map((data.items ?? []).map((item) => [item.id, item]));
  } catch {
    return null;
  }
}

/** Embeddable flag per id for search results. Missing ids default to embeddable (non-fatal). */
export async function fetchEmbeddability(videoIds: string[], apiKey: string): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (!videoIds.length) return map;
  const items = await fetchVideoItems(videoIds, apiKey, 'status');
  for (const [id, item] of items ?? []) map.set(id, item.status?.embeddable ?? true);
  return map;
}

/** Maps a videos.list item to a code; null means "looks fine" (caller decides). */
function classifyItem(item: VideoItem, viewerCountry: string | null): YoutubeAvailability | null {
  const upload = item.status?.uploadStatus;
  if (upload === 'deleted' || upload === 'rejected' || upload === 'failed') return 'not_found';
  if (item.status?.privacyStatus === 'private') return 'private';
  if (item.status?.embeddable === false) return 'embed_disabled';
  if (item.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted') return 'age_restricted';

  const region = item.contentDetails?.regionRestriction;
  if (region) {
    // `allowed: []` means blocked everywhere, regardless of where the viewer is.
    if (Array.isArray(region.allowed) && region.allowed.length === 0) return 'region_blocked';
    if (viewerCountry) {
      if (Array.isArray(region.allowed) && !region.allowed.includes(viewerCountry)) return 'region_blocked';
      if (region.blocked?.includes(viewerCountry)) return 'region_blocked';
    }
  }
  return null;
}

type OEmbedResult = 'ok' | 'missing' | 'forbidden';

/** Throws on network/upstream failure (5xx, timeout) so callers can report `check_failed`. */
async function probeOEmbed(videoId: string): Promise<OEmbedResult> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (res.ok) return 'ok';
  if (res.status === 404 || res.status === 400) return 'missing';
  if (res.status === 401 || res.status === 403) return 'forbidden';
  throw Object.assign(new Error(`oEmbed responded ${res.status}`), { status: 502 });
}

/**
 * Whether a YouTube video can be played through the IFrame API.
 *
 * With `YOUTUBE_API_KEY`: videos.list (status + contentDetails) gives the precise
 * reason, including age and region restrictions that oEmbed reports as playable.
 * Private and deleted videos are both omitted from videos.list, so oEmbed breaks
 * that tie. Without a key, or when the Data API fails: oEmbed only (200 = available,
 * 404/400 = not_found, 401/403 = restricted).
 *
 * `viewerCountry` (ISO 3166-1 alpha-2) enables per-viewer region checks.
 * Throws when no definitive answer could be obtained, so the caller can tell
 * "unavailable" apart from "couldn't check".
 */
export async function checkVideoAvailability(videoId: string, viewerCountry: string | null = null): Promise<YoutubeAvailability> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const items = apiKey ? await fetchVideoItems([videoId], apiKey, 'status,contentDetails') : null;

  if (items) {
    const item = items.get(videoId);
    if (item) return classifyItem(item, viewerCountry) ?? 'available';
    // Not listed: private or nonexistent.
    const probe = await probeOEmbed(videoId);
    if (probe === 'forbidden') return 'private';
    if (probe === 'missing') return 'not_found';
    return 'available'; // listed by oEmbed but not (yet) by the Data API — don't block
  }

  const probe = await probeOEmbed(videoId);
  if (probe === 'ok') return 'available';
  if (probe === 'missing') return 'not_found';
  return 'restricted';
}

/** Best-effort ISO country for an IP; null when unknown (private/loopback IPs, lookup failure). */
export async function lookupCountry(ip: string | undefined): Promise<string | null> {
  if (!ip) return null;
  try {
    const geoip = (await import('geoip-lite')).default;
    return geoip.lookup(ip)?.country ?? null;
  } catch {
    return null;
  }
}
