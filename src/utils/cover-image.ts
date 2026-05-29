import { extractYouTubeVideoId } from './youtube.js';

/** Build a stable YouTube thumbnail URL from a video URL or id. Null if unparseable. */
export function youtubeThumbnail(url: string | null | undefined): string | null {
  const id = extractYouTubeVideoId(url ?? null);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
