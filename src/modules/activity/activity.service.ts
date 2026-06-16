import mongoose from 'mongoose';
import Activity, { type ActivityType } from '../../db/activity.model.js';
import Follow from '../../db/follow.model.js';
import { getIO } from '../../socket/socket.manager.js';

export interface WriteActivityParams {
  actorId: string;
  type: ActivityType;
  projectId: string;
  projectTitle: string;
  coverImage: string;
  targetPath?: string;
}

function emitFeedNew(userId: string, activity: unknown): void {
  try { getIO().to(`user:${userId}`).emit('feed:new', activity); } catch { /* socket not ready */ }
}

export async function writeActivity(params: WriteActivityParams): Promise<void> {
  const { actorId, type, projectId, projectTitle, coverImage, targetPath } = params;

  const activity = await Activity.create({
    actorId: new mongoose.Types.ObjectId(actorId),
    type,
    projectId,
    projectTitle,
    coverImage,
    targetPath: targetPath ?? '',
  });

  // Fan-out to followers — fire-and-forget, never blocks the caller
  Follow.find({ followingId: new mongoose.Types.ObjectId(actorId) })
    .select('followerId')
    .lean()
    .then(followers => {
      const obj = activity.toObject();
      for (const f of followers) {
        emitFeedNew(f.followerId.toString(), obj);
      }
    })
    .catch(() => {});
}

export async function getFeed(
  userId: string,
  offset: number = 0,
  limit: number = 20
): Promise<{ activities: unknown[]; hasMore: boolean }> {
  const following = await Follow.find({ followerId: new mongoose.Types.ObjectId(userId) })
    .select('followingId')
    .lean();

  if (following.length === 0) return { activities: [], hasMore: false };

  const actorIds = following.map(f => f.followingId);
  const items = await Activity.find({ actorId: { $in: actorIds } })
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit + 1)
    .lean();

  return {
    activities: items.slice(0, limit),
    hasMore: items.length > limit,
  };
}

export async function getUserActivity(
  userId: string,
  offset: number = 0,
  limit: number = 50
): Promise<{ activities: unknown[]; hasMore: boolean }> {
  const items = await Activity.find({ actorId: new mongoose.Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit + 1)
    .lean();

  return {
    activities: items.slice(0, limit),
    hasMore: items.length > limit,
  };
}

export interface ActivityHeatmapDay {
  date: string;
  count: number;
}

// Aggregates activity counts by calendar date (UTC), bounded to the 90-day TTL window.
export async function getUserActivityHeatmap(userId: string): Promise<ActivityHeatmapDay[]> {
  const results = await Activity.aggregate([
    { $match: { actorId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
      },
    },
    { $project: { _id: 0, date: '$_id', count: 1 } },
    { $sort: { date: 1 } },
  ]);

  return results as ActivityHeatmapDay[];
}
