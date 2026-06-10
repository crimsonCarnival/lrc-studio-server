import { spotifyFetch, normalizeTrack } from './spotify.service.js';
import { stripHtml } from '../../utils/sanitize.js';

export async function search(userId: string, query: string, limit = 5, offset = 0): Promise<Record<string, unknown>> {
  if (!query?.trim()) return { error: 'Search query is required', status: 400 };

  const clampedLimit = Math.min(Math.max(1, limit), 10);
  const params = new URLSearchParams({
    q: query.trim(),
    type: 'track',
    limit: String(clampedLimit),
    offset: String(Math.max(0, offset)),
  });

  const data = await spotifyFetch(userId, `/search?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  return {
    tracks: ((data as Record<string, { items?: unknown[] }>)?.tracks?.items || []).map((t: unknown) => normalizeTrack(t as Record<string, unknown>)),
    total: (data as Record<string, { total?: number }>)?.tracks?.total || 0,
    offset: (data as Record<string, { offset?: number }>)?.tracks?.offset || 0,
    limit: (data as Record<string, { limit?: number }>)?.tracks?.limit || clampedLimit,
  };
}

export async function getSavedTracks(userId: string, limit = 20, offset = 0): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(1, limit), 50)),
    offset: String(Math.max(0, offset)),
  });

  const data = await spotifyFetch(userId, `/me/tracks?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  type SavedItem = { track: unknown; added_at: string };
  const typed = data as { items?: SavedItem[]; total?: number; offset?: number; limit?: number };
  return {
    tracks: (typed.items || []).map((item: SavedItem) => ({
      ...normalizeTrack(item.track as Record<string, unknown>),
      savedAt: item.added_at,
    })),
    total: typed.total || 0,
    offset: typed.offset || 0,
    limit: typed.limit || limit,
  };
}

export async function getRecentlyPlayed(userId: string, limit = 20): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(1, limit), 50)),
  });

  const data = await spotifyFetch(userId, `/me/player/recently-played?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  type RecentItem = { track: unknown; played_at: string };
  const typed = data as { items?: RecentItem[] };
  return {
    tracks: (typed.items || []).map((item: RecentItem) => ({
      ...normalizeTrack(item.track as Record<string, unknown>),
      playedAt: item.played_at,
    })),
  };
}

export async function getTopTracks(userId: string, timeRange = 'medium_term', limit = 20, offset = 0): Promise<Record<string, unknown>> {
  const validRanges = ['short_term', 'medium_term', 'long_term'];
  const range = validRanges.includes(timeRange) ? timeRange : 'medium_term';

  const params = new URLSearchParams({
    time_range: range,
    limit: String(Math.min(Math.max(1, limit), 50)),
    offset: String(Math.max(0, offset)),
  });

  const data = await spotifyFetch(userId, `/me/top/tracks?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  const typed = data as { items?: unknown[]; total?: number; offset?: number; limit?: number };
  return {
    tracks: (typed.items || []).map((t: unknown) => normalizeTrack(t as Record<string, unknown>)),
    total: typed.total || 0,
    offset: typed.offset || 0,
    limit: typed.limit || limit,
  };
}

export async function getMyPlaylists(userId: string, limit = 20, offset = 0): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(1, limit), 50)),
    offset: String(Math.max(0, offset)),
  });

  const data = await spotifyFetch(userId, `/me/playlists?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  type PlaylistItem = { id?: unknown; name?: string; description?: string; images?: { url: string }[]; items?: { total?: number }; tracks?: { total?: number }; owner?: { display_name?: string }; uri?: string };
  const typed = data as { items?: PlaylistItem[]; total?: number; offset?: number; limit?: number };
  return {
    playlists: (typed.items || []).map((p: PlaylistItem) => ({
      id: p.id,
      name: stripHtml(p.name || ''),
      description: stripHtml(p.description || ''),
      imageUrl: p.images?.[0]?.url || null,
      trackCount: (p.items?.total ?? p.tracks?.total ?? 0),
      owner: stripHtml(p.owner?.display_name || ''),
      uri: p.uri,
    })),
    total: typed.total || 0,
    offset: typed.offset || 0,
    limit: typed.limit || limit,
  };
}

export async function getPlaylistTracks(userId: string, playlistId: string, limit = 20, offset = 0): Promise<Record<string, unknown>> {
  if (!playlistId) return { error: 'Playlist ID is required', status: 400 };

  const params = new URLSearchParams({
    limit: String(Math.min(Math.max(1, limit), 50)),
    offset: String(Math.max(0, offset)),
  });

  const data = await spotifyFetch(userId, `/playlists/${encodeURIComponent(playlistId)}/items?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  type PlaylistTrackItem = { track?: unknown; added_at?: unknown };
  const typed = data as { items?: PlaylistTrackItem[]; total?: number; offset?: number; limit?: number };
  return {
    tracks: (typed.items || [])
      .filter((item: PlaylistTrackItem) => {
        if (!item.track) return false; // deleted / null track
        const t = item.track as Record<string, unknown>;
        return t.type !== 'episode'; // exclude podcast episodes
      })
      .map((item: PlaylistTrackItem) => ({
        ...normalizeTrack(item.track as Record<string, unknown>),
        addedAt: item.added_at,
      }))
      .filter((t) => (t as Record<string, unknown>).trackId != null), // drop local/unresolvable tracks with no ID
    total: typed.total || 0,
    offset: typed.offset || 0,
    limit: typed.limit || limit,
  };
}

export async function createPlaylist(userId: string, name: string, description = '', isPublic = false): Promise<Record<string, unknown>> {
  if (!name?.trim()) return { error: 'Playlist name is required', status: 400 };

  const data = await spotifyFetch(userId, '/me/playlists', {
    method: 'POST',
    body: JSON.stringify({
      name: name.trim().slice(0, 200),
      description: (description || '').trim().slice(0, 300),
      public: isPublic,
    }),
  });
  if ((data as Record<string, unknown>).error) return data;

  return {
    id: (data as Record<string, unknown>).id,
    name: (data as Record<string, unknown>).name,
    uri: (data as Record<string, unknown>).uri,
  };
}

export async function addToPlaylist(userId: string, playlistId: string, uris: string[]): Promise<Record<string, unknown>> {
  if (!playlistId) return { error: 'Playlist ID is required', status: 400 };
  if (!uris?.length) return { error: 'At least one URI is required', status: 400 };

  const batch = uris.slice(0, 100);
  const data = await spotifyFetch(userId, `/playlists/${encodeURIComponent(playlistId)}/items`, {
    method: 'POST',
    body: JSON.stringify({ uris: batch }),
  });

  return data;
}

export async function saveToLibrary(userId: string, uris: string[]): Promise<Record<string, unknown>> {
  if (!uris?.length) return { error: 'At least one URI is required', status: 400 };

  const params = new URLSearchParams({ uris: uris.slice(0, 40).join(',') });
  return spotifyFetch(userId, `/me/library?${params}`, { method: 'PUT' });
}

export async function removeFromLibrary(userId: string, uris: string[]): Promise<Record<string, unknown>> {
  if (!uris?.length) return { error: 'At least one URI is required', status: 400 };

  const params = new URLSearchParams({ uris: uris.slice(0, 40).join(',') });
  return spotifyFetch(userId, `/me/library?${params}`, { method: 'DELETE' });
}

export async function checkLibrary(userId: string, uris: string[]): Promise<Record<string, unknown>> {
  if (!uris?.length) return { error: 'At least one URI is required', status: 400 };

  const params = new URLSearchParams({ uris: uris.slice(0, 40).join(',') });
  const data = await spotifyFetch(userId, `/me/library/contains?${params}`);
  if ((data as Record<string, unknown>).error) return data;

  const results: Record<string, boolean> = {};
  uris.slice(0, 40).forEach((uri, i) => {
    results[uri] = Array.isArray(data) ? !!data[i] : false;
  });
  return { results };
}