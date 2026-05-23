import { createHmac } from 'node:crypto';

const BASE_URL = 'https://www.musixmatch.com/ws/1.1/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36';
const SECRET_TTL_MS = 6 * 60 * 60 * 1000;

// --- Secret extraction & caching ---

let cachedSecret: { value: string; at: number } | null = null;

async function getLatestAppUrl(): Promise<string> {
  const res = await fetch('https://www.musixmatch.com/search', {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Cookie': 'mxm_bab=AB',
    },
  });
  const html = await res.text();
  const matches = [...html.matchAll(/src="([^"]*\/_next\/static\/chunks\/pages\/_app-[^"]+\.js)"/g)];
  if (!matches.length) throw new Error('musixmatch_app_url_not_found');
  return matches[matches.length - 1][1];
}

async function fetchSecret(): Promise<string> {
  const appUrl = await getLatestAppUrl();
  const res = await fetch(appUrl, { headers: { 'User-Agent': USER_AGENT } });
  const js = await res.text();
  // The secret is a reversed, Base64-encoded string passed to from("...".split(...))
  const match = js.match(/from\(\s*"(.*?)"\s*\.split/);
  if (!match) throw new Error('musixmatch_secret_not_found');
  const reversed = match[1].split('').reverse().join('');
  return Buffer.from(reversed, 'base64').toString('utf-8');
}

async function getSecret(): Promise<string> {
  if (cachedSecret && Date.now() - cachedSecret.at < SECRET_TTL_MS) return cachedSecret.value;
  const value = await fetchSecret();
  cachedSecret = { value, at: Date.now() };
  return value;
}

// --- HMAC-SHA256 signature (date-bound, matches Python port exactly) ---

function generateSignature(url: string, secret: string): string {
  const now = new Date();
  const y = now.getFullYear().toString();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  const digest = createHmac('sha256', secret).update(url + y + m + d).digest();
  return `&signature=${encodeURIComponent(digest.toString('base64'))}&signature_protocol=sha256`;
}

// --- Request helper ---

async function makeRequest<T>(path: string): Promise<T> {
  const secret = await getSecret();
  const url = BASE_URL + path.replace(/%20/g, '+').replace(/ /g, '+');
  const signed = url + generateSignature(url, secret);
  const res = await fetch(signed, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`musixmatch_http_${res.status}`);
  return res.json() as Promise<T>;
}

// --- Response types ---

interface MxmHeader { status_code: number }

interface MxmTrack {
  track_id: number;
  commontrack_id: number;
  track_name: string;
  artist_name: string;
  has_lyrics: number;
  has_richsync: number;
}

interface MxmSearchResponse {
  message: { header: MxmHeader; body: { track_list: Array<{ track: MxmTrack }> } };
}

interface MxmLyricsResponse {
  message: { header: MxmHeader; body: { lyrics: { lyrics_body: string; restricted: number } } };
}

interface MxmRichsyncLine {
  ts: number;
  te: number;
  x: string; // full line text
  l: Array<{ c: string; o: number }>;
}

interface MxmRichsyncResponse {
  message: { header: MxmHeader; body: { richsync: { richsync_body: string; restricted: number } } };
}

// --- Public API ---

async function searchTracks(query: string): Promise<MxmTrack[]> {
  const data = await makeRequest<MxmSearchResponse>(
    `track.search?app_id=web-desktop-app-v1.0&format=json&q=${encodeURIComponent(query)}&f_has_lyrics=true&page_size=5&page=1`,
  );
  if (data.message.header.status_code !== 200) return [];
  return data.message.body.track_list.map(t => t.track);
}

function stripCommercialNotice(body: string): string {
  return body.replace(/\n*\.\.\.\n\*{7}[\s\S]*$/, '').trim();
}

async function getPlainLyrics(trackId: number): Promise<string | null> {
  const data = await makeRequest<MxmLyricsResponse>(
    `track.lyrics.get?app_id=web-desktop-app-v1.0&format=json&track_id=${trackId}`,
  );
  if (data.message.header.status_code !== 200) return null;
  const { lyrics } = data.message.body;
  if (lyrics.restricted) return null;
  return stripCommercialNotice(lyrics.lyrics_body);
}

async function getRichsyncLines(commontrackId: number, trackId: number): Promise<MxmRichsyncLine[] | null> {
  const data = await makeRequest<MxmRichsyncResponse>(
    `track.richsync.get?app_id=web-desktop-app-v1.0&format=json&commontrack_id=${commontrackId}&track_id=${trackId}`,
  );
  if (data.message.header.status_code !== 200) return null;
  const { richsync } = data.message.body;
  if (richsync.restricted) return null;
  try {
    return JSON.parse(richsync.richsync_body) as MxmRichsyncLine[];
  } catch {
    return null;
  }
}

export async function getLyricsForSong(track: string, artist: string): Promise<string | null> {
  const tracks = await searchTracks(`${track} ${artist}`);
  if (!tracks.length) return null;

  const best = tracks[0];
  if (!best.has_lyrics) return null;

  // Richsync embeds full line text in each entry's `x` field — not subject to free-tier truncation
  if (best.has_richsync) {
    const lines = await getRichsyncLines(best.commontrack_id, best.track_id);
    if (lines?.length) return lines.map(l => l.x).join('\n');
  }

  return getPlainLyrics(best.track_id);
}
