import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkVideoAvailability, fetchEmbeddability, lookupCountry } from './youtube.service.js';
import type { YoutubeAvailability } from './youtube.service.js';

/**
 * Shared by both routes. Returns the status, or null after replying with
 * 400 `invalid_id` / 502 `check_failed` (never the upstream error text).
 */
async function resolveAvailability(request: FastifyRequest, reply: FastifyReply): Promise<YoutubeAvailability | null> {
  if (request.validationError) {
    reply.code(400).send({ error: 'invalid_id', code: 'invalid_id' });
    return null;
  }
  const { videoId } = request.query as { videoId: string };
  try {
    return await checkVideoAvailability(videoId, await lookupCountry(request.ip));
  } catch (error) {
    request.log.warn({ err: error, videoId }, 'YouTube availability check failed');
    reply.code(502).send({ error: 'check_failed', code: 'check_failed' });
    return null;
  }
}

export async function checkAvailability(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const status = await resolveAvailability(request, reply);
  if (status) return reply.send({ status });
}

/** @deprecated Legacy contract `{ embeddable }` kept for cached clients; use GET /youtube/availability. */
export async function checkEmbed(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const status = await resolveAvailability(request, reply);
  if (status) return reply.send({ embeddable: status === 'available', status });
}

export async function searchYoutube(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const query = (request.query as Record<string, string>).q;
    if (!query) {
      return reply.code(400).send({ error: 'Missing search query' });
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return reply.code(500).send({ error: 'YouTube API key is not configured' });
    }

    const params = new URLSearchParams({
      part: 'snippet',
      maxResults: '10',
      q: query,
      type: 'video',
      key: apiKey,
    });

    const response = await fetch('https://www.googleapis.com/youtube/v3/search?' + params.toString());

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      request.log.error(errData, 'YouTube API error');
      return reply.code(502).send({ error: 'YouTube API request failed' });
    }

    const data = await response.json().catch(() => ({})) as {
      items?: Array<{
        id: { videoId?: string };
        snippet: {
          title?: string;
          description?: string;
          channelTitle?: string;
          publishedAt?: string;
          thumbnails?: {
            high?: { url?: string };
            medium?: { url?: string };
            default?: { url?: string };
          };
        };
      }>;
    };
    if (!data.items) {
      request.log.warn({ data }, 'YouTube API returned unexpected format');
    }

    const filtered = (data.items || []).filter(item => !!item.id?.videoId);
    const videoIds = filtered.map(item => item.id.videoId!);
    const embeddabilityMap = await fetchEmbeddability(videoIds, apiKey);

    const items = filtered.map(item => ({
      videoId: item.id.videoId!,
      title: item.snippet?.title || 'Unknown Title',
      description: item.snippet?.description || '',
      thumbnail: item.snippet?.thumbnails?.high?.url ||
        item.snippet?.thumbnails?.medium?.url ||
        item.snippet?.thumbnails?.default?.url || '',
      channelTitle: item.snippet?.channelTitle || 'Unknown Channel',
      publishedAt: item.snippet?.publishedAt || new Date().toISOString(),
      embeddable: embeddabilityMap.get(item.id.videoId!) ?? true,
    }));

    return reply.send({ results: items });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: 'Failed to search YouTube' });
  }
}