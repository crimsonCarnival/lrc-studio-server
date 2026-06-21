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

  if (followingIds.length > 0) {
    const secondDegree = await Follow.find({
      followerId: { $in: followingIds },
      followingId: { $nin: [...followingIds, viewerObjectId] },
    })
      .select('followingId')
      .lean();

    const candidateIds = [...new Set(secondDegree.map((f) => f.followingId.toString()))]
      .filter((id) => !blockedSet.has(id));

    if (candidateIds.length > 0) {
      const users = await User.find({
        _id: { $in: candidateIds },
        ...ACTIVE_USER_FILTER,
      })
        .select('accountName displayName avatarUrl')
        .limit(limit)
        .lean<UserLean[]>();

      return users.map((u) => ({
        id: u._id.toString(),
        accountName: u.accountName ?? null,
        displayName: u.displayName ?? null,
        avatarUrl: u.avatarUrl ?? null,
      }));
    }
  }

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
