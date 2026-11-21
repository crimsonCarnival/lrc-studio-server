import Project from '../projects/project.model.js';
import Playlist from '../playlists/playlist.model.js';
import Follow from '../users/follow.model.js';
import User from '../users/user.model.js';
import { getBlockedSet } from '../blocks/block.service.js';
import { socialGraph } from '../../lib/social-graph.js';
import mongoose from 'mongoose';

interface UserLean {
  _id: { toString(): string };
  accountName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

const ACTIVE_USER_FILTER = { isDeleted: { $ne: true }, 'ban.active': { $ne: true }, 'shadowBan.search': { $ne: true } };

export async function getTrendingProjects(offset: number, limit: number, viewerId?: string) {
  const blockedSet = await getBlockedSet(viewerId);
  // ownerListed: a deactivated, banned or shadow-banned owner's work is not a
  // discovery surface. Denormalized so this stays a single-collection query
  // with an index-provided sort — see modules/users/owner-visibility.service.ts.
  const filter: Record<string, unknown> = { public: true, ownerListed: true, listed: { $ne: false } };
  if (blockedSet.size > 0) {
    filter.userId = { $nin: [...blockedSet].map((id) => new mongoose.Types.ObjectId(id)) };
  }
  // Covered projects first (hasCover, derived from coverImage), then ranking
  // (recency, engagement decay, owner diversity — baked into trendingScore by
  // jobs/trending.job.ts). All three keys are in one index, so no in-memory sort.
  const [projects, total] = await Promise.all([
    Project.find(filter)
      .sort({ hasCover: -1, trendingScore: -1, createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('userId', 'accountName displayName avatarUrl'),
    Project.countDocuments(filter),
  ]);

  return { projects, total, hasMore: offset + projects.length < total };
}

export async function getPopularPlaylists(offset: number, limit: number, viewerId?: string) {
  const blockedSet = await getBlockedSet(viewerId);
  const filter: Record<string, unknown> = { isPublic: true, ownerListed: true, listed: { $ne: false } };
  if (blockedSet.size > 0) {
    filter.userId = { $nin: [...blockedSet].map((id) => new mongoose.Types.ObjectId(id)) };
  }
  const [playlists, total] = await Promise.all([
    Playlist.find(filter)
      .sort({ trendingScore: -1, createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('owner', 'accountName displayName avatarUrl'),
    Playlist.countDocuments(filter),
  ]);

  return { playlists, total, hasMore: offset + playlists.length < total };
}

/** Why a user is suggested, so the client can say it ("Followed by Ana", "Radiohead in common"). */
export type SuggestionReason = {
  kind: 'MUTUAL' | 'TASTE' | 'NEW';
  /** MUTUAL: how many people the viewer follows also follow this user, and one of them by name. */
  mutualCount: number;
  mutualName: string | null;
  /** TASTE: artists in both music libraries (up to three, as this user spelled them) and their total. */
  sharedArtistCount: number;
  sharedArtists: string[];
};

export type SuggestedUser = {
  id: string;
  accountName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  staffRole: string | null;
  /** Always false: everyone the viewer follows is left out. */
  isFollowedByMe: false;
  suggestionReason: SuggestionReason;
};

interface SuggestedUserLean extends UserLean {
  role?: string | null;
}

const SUGGESTED_USER_FIELDS = 'accountName displayName avatarUrl role';
const MAX_SHARED_ARTISTS = 3;

type Candidate = { score: number; mutualIds: string[]; sharedArtists: string[] };

function toSuggested(u: SuggestedUserLean, reason: SuggestionReason): SuggestedUser {
  return {
    id: u._id.toString(),
    accountName: u.accountName ?? null,
    displayName: u.displayName ?? null,
    avatarUrl: u.avatarUrl ?? null,
    staffRole: u.role && u.role !== 'user' ? u.role : null,
    isFollowedByMe: false,
    suggestionReason: reason,
  };
}

const NEW_USER_REASON: SuggestionReason = { kind: 'NEW', mutualCount: 0, mutualName: null, sharedArtistCount: 0, sharedArtists: [] };

/**
 * People the viewer might follow, best first: friends of friends (someone the viewer
 * follows follows them) and music-taste matches, topped up with the newest users when
 * those run short. Never the viewer, anyone they follow, or anyone blocked either way.
 */
export async function getSuggestedUsers(viewerId: string, limit: number): Promise<SuggestedUser[]> {
  if (!viewerId || !mongoose.isValidObjectId(viewerId)) return [];

  const viewerObjectId = new mongoose.Types.ObjectId(viewerId);
  const blockedSet = await getBlockedSet(viewerId);

  const following = await Follow.find({ followerId: viewerObjectId }).select('followingId').lean();
  const followingIds = following.map((f) => f.followingId);
  const followingSet = new Set(followingIds.map((id) => id.toString()));
  const excluded = (id: string) => id === viewerId || followingSet.has(id) || blockedSet.has(id);

  const candidates = new Map<string, Candidate>();
  const candidate = (id: string): Candidate => {
    let c = candidates.get(id);
    if (!c) { c = { score: 0, mutualIds: [], sharedArtists: [] }; candidates.set(id, c); }
    return c;
  };

  // Source 1: friends of friends via the in-memory follow graph (directed: neighbors = followees).
  for (const neighborId of socialGraph.neighbors(viewerId)) {
    if (blockedSet.has(neighborId)) continue;
    for (const candidateId of socialGraph.neighbors(neighborId)) {
      if (excluded(candidateId)) continue;
      const c = candidate(candidateId);
      c.score += 2;
      c.mutualIds.push(neighborId);
    }
  }

  // Source 2: music taste, users sharing artists from the viewer's musicLibrary.
  const viewer = await User.findById(viewerObjectId).select('musicLibrary').lean<{ musicLibrary?: Array<{ artist: string }> }>();
  const viewerArtists = new Set(
    (viewer?.musicLibrary ?? [])
      .map((e) => e.artist?.toLowerCase().trim())
      .filter(Boolean),
  );

  if (viewerArtists.size > 0) {
    const tasteMatches = await User.find({
      _id: { $ne: viewerObjectId, $nin: [...blockedSet].map((id) => new mongoose.Types.ObjectId(id)) },
      'musicLibrary.artist': { $in: [...viewerArtists].map((a) => new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) },
      ...ACTIVE_USER_FILTER,
    })
      .select('_id musicLibrary')
      .limit(50)
      .lean<{ _id: { toString(): string }; musicLibrary?: Array<{ artist: string }> }[]>();

    for (const u of tasteMatches) {
      const id = u._id.toString();
      if (excluded(id)) continue;
      const shared = new Map<string, string>();
      for (const e of u.musicLibrary ?? []) {
        const key = e.artist?.toLowerCase().trim();
        if (key && viewerArtists.has(key) && !shared.has(key)) shared.set(key, e.artist.trim());
      }
      if (shared.size === 0) continue;
      const c = candidate(id);
      c.score += shared.size;
      c.sharedArtists = [...shared.values()];
    }
  }

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit * 2)
    .map(([id]) => id);

  const results: SuggestedUser[] = [];
  if (ranked.length > 0) {
    const users = await User.find({ _id: { $in: ranked }, ...ACTIVE_USER_FILTER })
      .select(SUGGESTED_USER_FIELDS)
      .lean<SuggestedUserLean[]>();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));
    const top = ranked.filter((id) => userMap.has(id)).slice(0, limit);

    // One query names a mutual follow for every MUTUAL row.
    const mutualIds = [...new Set(top.map((id) => candidates.get(id)!.mutualIds[0]).filter(Boolean))];
    const mutualUsers = mutualIds.length > 0
      ? await User.find({ _id: { $in: mutualIds }, ...ACTIVE_USER_FILTER }).select('accountName displayName').lean<UserLean[]>()
      : [];
    const mutualName = new Map(mutualUsers.map((u) => [u._id.toString(), u.displayName || u.accountName || null]));

    for (const id of top) {
      const c = candidates.get(id)!;
      const named = c.mutualIds.map((m) => mutualName.get(m)).find(Boolean) ?? null;
      results.push(toSuggested(userMap.get(id)!, {
        kind: c.mutualIds.length > 0 ? 'MUTUAL' : 'TASTE',
        mutualCount: c.mutualIds.length,
        mutualName: named,
        sharedArtistCount: c.sharedArtists.length,
        sharedArtists: c.sharedArtists.slice(0, MAX_SHARED_ARTISTS),
      }));
    }
  }

  // Top up with the newest users, still leaving out anyone followed or already listed.
  if (results.length < limit) {
    const skip = [viewerObjectId, ...followingIds, ...[...blockedSet].map((id) => new mongoose.Types.ObjectId(id)), ...results.map((r) => new mongoose.Types.ObjectId(r.id))];
    const newest = await User.find({ _id: { $nin: skip }, ...ACTIVE_USER_FILTER })
      .sort({ createdAt: -1 })
      .limit(limit - results.length)
      .select(SUGGESTED_USER_FIELDS)
      .lean<SuggestedUserLean[]>();
    for (const u of newest) results.push(toSuggested(u, NEW_USER_REASON));
  }

  return results;
}

// Three full-collection counts for three numbers that change slowly — same
// cache shape as addiction-level.service.ts's getLevelsSorted. No
// invalidation hook: these are advisory totals shown on an explore page, not
// values anything else reads back for correctness, so going briefly stale
// between recomputes is the right trade against recounting on every view.
let cachedExploreStats: { totalProjects: number; totalUsers: number; totalPlaylists: number; totalViews: number; totalStars: number } | null = null;
let exploreStatsCachedAt = 0;
const EXPLORE_STATS_TTL_MS = 60_000; // 1 minute

export async function getExploreStats() {
  const now = Date.now();
  if (cachedExploreStats && now - exploreStatsCachedAt < EXPLORE_STATS_TTL_MS) return cachedExploreStats;

  const projectFilter = { public: true, ownerListed: true, listed: { $ne: false } };
  const [totalProjects, totalUsers, totalPlaylists, engagement] = await Promise.all([
    Project.countDocuments(projectFilter),
    User.countDocuments({ isVerified: true }),
    Playlist.countDocuments({ isPublic: true, ownerListed: true, listed: { $ne: false } }),
    Project.aggregate<{ views: number; stars: number }>([
      { $match: projectFilter },
      { $group: { _id: null, views: { $sum: { $ifNull: ['$viewCount', 0] } }, stars: { $sum: { $ifNull: ['$starCount', 0] } } } },
    ]),
  ]);

  const totalViews = engagement[0]?.views ?? 0;
  const totalStars = engagement[0]?.stars ?? 0;
  cachedExploreStats = { totalProjects, totalUsers, totalPlaylists, totalViews, totalStars };
  exploreStatsCachedAt = now;
  return cachedExploreStats;
}

/** Test-only escape hatch — same shape as addiction-level.service.ts's invalidateLevelCache. */
export function invalidateExploreStatsCache(): void {
  cachedExploreStats = null;
  exploreStatsCachedAt = 0;
}
