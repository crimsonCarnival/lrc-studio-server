import { LRUCache } from '@crimson-carnival/ds-js';

interface YouTubeMetadata {
  title: string | null;
  duration: number | null;
}

const ytCache = new LRUCache<string, YouTubeMetadata>(100);

export function extractYouTubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;

  const patterns = [
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|watch\?.+&v=)|youtu\.be\/)([^&?/\s]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
    return url;
  }

  return null;
}

export async function fetchYouTubeTitle(url: string): Promise<string | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    // Fallback to oEmbed which doesn't require API key
    return fetchYouTubeTitleViaOEmbed(url);
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    console.warn('Invalid YouTube URL:', url);
    return null;
  }

  const cached = ytCache.get(videoId);
  if (cached?.title) return cached.title;

  try {
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      console.error('YouTube API error:', response.status, response.statusText);
      return null;
    }

    const data = await response.json() as { items?: Array<{ snippet: { title: string } }> };

    if (data.items && data.items.length > 0) {
      const title = data.items[0].snippet.title;
      ytCache.put(videoId, { title, duration: null });
      return title;
    }

    console.warn('No video found for ID:', videoId);
    return null;
  } catch (error: unknown) {
    console.error('Error fetching YouTube title:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function fetchYouTubeMetadata(url: string): Promise<YouTubeMetadata | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  const cached = ytCache.get(videoId);
  if (cached && cached.duration !== null) return cached;

  if (apiKey) {
    // Try official API first
    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(apiUrl);
      if (!response.ok) return null;

      const data = await response.json() as {
        items?: Array<{
          snippet: { title: string };
          contentDetails: { duration: string };
        }>;
      };
      if (!data.items?.length) return null;

      const item = data.items[0];
      const title = item.snippet.title;
      const duration = parseISO8601Duration(item.contentDetails.duration);

      const result: YouTubeMetadata = { title, duration };
      ytCache.put(videoId, result);
      return result;
    } catch {
      // Fall through to oEmbed
    }
  }

  // Fallback to oEmbed (no API key required, but only returns title)
  const oembedTitle = await fetchYouTubeTitleViaOEmbed(url);
  if (oembedTitle) {
    return { title: oembedTitle, duration: null };
  }

  return null;
}

function parseISO8601Duration(iso: string): number | null {
  if (!iso) return null;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  return h * 3600 + m * 60 + s;
}

// Fallback using YouTube oEmbed API (no API key required)
async function fetchYouTubeTitleViaOEmbed(url: string): Promise<string | null> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) return null;

    const data = await response.json() as { title?: string };
    return data.title || null;
  } catch {
    return null;
  }
}