import type { FastifyRequest, FastifyReply } from 'fastify';

async function fetchEmbeddability(videoIds: string[], apiKey: string): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (!videoIds.length) return map;
  const params = new URLSearchParams({ part: 'status', id: videoIds.join(','), key: apiKey });
  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/videos?' + params.toString());
    if (!res.ok) return map;
    const data = await res.json() as { items?: Array<{ id: string; status: { embeddable: boolean } }> };
    for (const item of data.items || []) {
      map.set(item.id, item.status?.embeddable ?? true);
    }
  } catch { /* non-fatal — default to embeddable */ }
  return map;
}

export async function checkEmbed(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const videoId = (request.query as Record<string, string>).videoId;
  if (!videoId) return reply.code(400).send({ error: 'Missing videoId' });
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return reply.code(500).send({ error: 'YouTube API key not configured' });
  const map = await fetchEmbeddability([videoId], apiKey);
  return reply.send({ embeddable: map.get(videoId) ?? true });
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
    return reply.code(500).send({ error: 'Failed to search YouTube', details: (error as Error).message });
  }
}