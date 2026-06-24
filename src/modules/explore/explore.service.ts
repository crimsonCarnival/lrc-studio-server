import Project from '../projects/project.model.js';
import Playlist from '../../db/playlist.model.js';
import Follow from '../../db/follow.model.js';
import User from '../../db/user.model.js';
import { getBlockedSet } from '../blocks/block.service.js';
import mongoose from 'mongoose';

interface UserLean {
  _id: { toString(): string };
  accountName?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

const ACTIVE_USER_FILTER = { isDeleted: { $ne: true }, 'ban.active': { $ne: true } };

export async function getTrendingProjects(offset: number, limit: number, viewerId?: string) {
  const blockedSet = await getBlockedSet(viewerId);
  const filter: Record<string, unknown> = { public: true };
  if (blockedSet.size > 0) {
    filter.userId = { $nin: [...blockedSet].map((id) => new mongoose.Types.ObjectId(id)) };
  }
  const [projects, total] = await Promise.all([
    Project.find(filter)
      .sort({ trendingScore: -1, createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('userId', 'accountName displayName avatarUrl'),
    Project.countDocuments(filter),
  ]);

  return { projects, total, hasMore: offset + projects.length < total };
}

export async function getPopularPlaylists(offset: number, limit: number) {
  const filter = { isPublic: true };
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

export async function getSuggestedUsers(viewerId: string, limit: number) {
  if (!viewerId) return [];

  const viewerObjectId = new mongoose.Types.ObjectId(viewerId);
  const blockedSet = await getBlockedSet(viewerId);
  const blockedOids = [...blockedSet].map((id) => new mongoose.Types.ObjectId(id));

  const following = await Follow.find({ followerId: viewerObjectId }).select('followingId').lean();
  const followingIds = following.map((f) => f.followingId);
  const followingSet = new Set(followingIds.map(id => id.toString()));

  // Collect candidates from two sources: friends-of-friends AND music taste matches.
  const candidateScores = new Map<string, number>();

  // Source 1: friends-of-friends
  if (followingIds.length > 0) {
    const secondDegree = await Follow.find({
      followerId: { $in: followingIds },
      followingId: { $nin: [...followingIds, viewerObjectId] },
    })
      .select('followingId')
      .lean();

    for (const f of secondDegree) {
      const id = f.followingId.toString();
      if (!blockedSet.has(id)) {
        candidateScores.set(id, (candidateScores.get(id) ?? 0) + 2);
      }
    }
  }

  // Source 2: music taste — users sharing artists from viewer's musicLibrary
  const viewer = await User.findById(viewerObjectId).select('musicLibrary').lean<{ musicLibrary?: Array<{ artist: string }> }>();
  const viewerArtists = new Set(
    (viewer?.musicLibrary ?? [])
      .map(e => e.artist?.toLowerCase().trim())
      .filter(Boolean)
  );

  if (viewerArtists.size > 0) {
    const tasteMatches = await User.find({
      _id: { $ne: viewerObjectId, $nin: blockedOids },
      'musicLibrary.artist': { $in: [...viewerArtists].map(a => new RegExp(`^${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) },
      ...ACTIVE_USER_FILTER,
    })
      .select('_id musicLibrary')
      .limit(50)
      .lean<{ _id: { toString(): string }; musicLibrary?: Array<{ artist: string }> }[]>();

    for (const u of tasteMatches) {
      const id = u._id.toString();
      if (followingSet.has(id) || blockedSet.has(id)) continue;
      const overlap = (u.musicLibrary ?? []).filter(e =>
        viewerArtists.has(e.artist?.toLowerCase().trim())
      ).length;
      if (overlap > 0) {
        candidateScores.set(id, (candidateScores.get(id) ?? 0) + overlap);
      }
    }
  }

  // Fetch and return top candidates by score
  if (candidateScores.size > 0) {
    const ranked = [...candidateScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit * 2)
      .map(([id]) => id);

    const users = await User.find({
      _id: { $in: ranked },
      ...ACTIVE_USER_FILTER,
    })
      .select('accountName displayName avatarUrl')
      .lean<UserLean[]>();

    // Re-sort by score
    const userMap = new Map(users.map(u => [u._id.toString(), u]));
    const sorted = ranked
      .map(id => userMap.get(id))
      .filter((u): u is UserLean => !!u)
      .slice(0, limit);

    return sorted.map((u) => ({
      id: u._id.toString(),
      accountName: u.accountName ?? null,
      displayName: u.displayName ?? null,
      avatarUrl: u.avatarUrl ?? null,
    }));
  }

  // Fallback: newest users
  const users = await User.find({
    _id: { $ne: viewerObjectId, $nin: blockedOids },
    ...ACTIVE_USER_FILTER,
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('accountName displayName avatarUrl')
    .lean<UserLean[]>();

  return users.map((u) => ({
    id: u._id.toString(),
    accountName: u.accountName ?? null,
    displayName: u.displayName ?? null,
    avatarUrl: u.avatarUrl ?? null,
  }));
}

export async function getExploreStats() {
  const [totalProjects, totalUsers, totalPlaylists] = await Promise.all([
    Project.countDocuments({ public: true }),
    User.countDocuments({ isVerified: true }),
    Playlist.countDocuments({ isPublic: true }),
  ]);

  return { totalProjects, totalUsers, totalPlaylists };
}
