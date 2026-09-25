import mongoose from 'mongoose';
import Activity, { type ActivityType } from '../../db/activity.model.js';
import Follow from '../../db/follow.model.js';
import HeatmapDay, { type IHeatmapDay } from '../../db/heatmap-day.model.js';
import User from '../../db/user.model.js';
import { enqueueFanOut } from './fan-out.queue.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';

export interface WriteActivityParams {
  actorId: string;
  type: ActivityType;
  publicId: string;
  projectTitle: string;
  coverImage: string;
  targetPath?: string;
}

export async function writeActivity(params: WriteActivityParams): Promise<void> {
  const { actorId, type, publicId, projectTitle, coverImage, targetPath } = params;

  const activity = await Activity.create({
    actorId: new mongoose.Types.ObjectId(actorId),
    type,
    publicId,
    projectTitle,
    coverImage,
    targetPath: targetPath ?? '',
  });

  // Fan-out to followers — fire-and-forget via queue, never blocks the caller
  Follow.find({ followingId: new mongoose.Types.ObjectId(actorId) })
    .select('followerId')
    .lean()
    .then(followers => {
      if (followers.length === 0) return;
      enqueueFanOut({
        actorId,
        followerIds: followers.map(f => f.followerId.toString()),
        activity: activity.toObject(),
      });
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

  // Exclude actors who are shadow-banned from feed
  const shadowBannedIds = await User.find(
    { _id: { $in: actorIds }, 'shadowBan.feed': true },
    '_id'
  ).lean().then(docs => new Set(docs.map(d => d._id.toString())));

  const filteredActorIds = actorIds.filter(id => !shadowBannedIds.has(id.toString()));

  const items = await Activity.find({ actorId: { $in: filteredActorIds } })
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

const HEATMAP_WINDOW_DAYS = 365;
const DAY_MS = 86400000;

// Manual saves are cheap to spam (Ctrl+S). Capping their per-day contribution
// keeps one save-happy session from pinning the day at the top legend bucket
// ("10+") on its own; creations are already bounded by the project quota + reCAPTCHA.
export const MAX_MANUAL_SAVES_PER_DAY = 5;

export type HeatmapEventKind = 'project_created' | 'manual_save';

function startOfUtcDay(date: Date): Date {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/**
 * Counts a private authoring event toward the owner's heatmap. Writes only to
 * the heatmap_days counters — never to `activities` — so it can't reach the
 * social feed. One upsert per event; manual saves are clamped server-side.
 */
export async function recordHeatmapEvent(
  userId: string,
  kind: HeatmapEventKind,
  now: Date = new Date()
): Promise<void> {
  const filter = { userId: new mongoose.Types.ObjectId(userId), day: startOfUtcDay(now) };
  // Pipeline form so the cap is applied atomically in the same write.
  const update = kind === 'project_created'
    ? { $inc: { projectsCreated: 1 } }
    : [{
        $set: {
          projectsCreated: { $ifNull: ['$projectsCreated', 0] },
          manualSaves: {
            $min: [{ $add: [{ $ifNull: ['$manualSaves', 0] }, 1] }, MAX_MANUAL_SAVES_PER_DAY],
          },
        },
      }];
  try {
    await HeatmapDay.updateOne(filter, update, { upsert: true });
  } catch (err) {
    // Two concurrent upserts creating the same (user, day) doc: one loses on the
    // unique index. The doc now exists, so a single retry takes the update path.
    if (!isDuplicateKeyError(err)) throw err;
    await HeatmapDay.updateOne(filter, update, { upsert: true });
  }
}

// Merges two sources per UTC calendar date ($dateToString's default timezone):
// social `activities` (365-day TTL, { actorId, createdAt } index) and private
// authoring counters in heatmap_days ({ userId, day } index, ~400-day TTL).
// Both are bounded to the same window starting at a UTC day boundary.
export async function getUserActivityHeatmap(userId: string): Promise<ActivityHeatmapDay[]> {
  const since = startOfUtcDay(new Date(Date.now() - HEATMAP_WINDOW_DAYS * DAY_MS));
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const [socialDays, counterDays] = await Promise.all([
    Activity.aggregate<ActivityHeatmapDay>([
      { $match: { actorId: userObjectId, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $project: { _id: 0, date: '$_id', count: 1 } },
    ]),
    HeatmapDay.find({ userId: userObjectId, day: { $gte: since } })
      .select('day projectsCreated manualSaves -_id')
      .lean<Pick<IHeatmapDay, 'day' | 'projectsCreated' | 'manualSaves'>[]>(),
  ]);

  const counts = new Map<string, number>();
  for (const d of socialDays) counts.set(d.date, d.count);
  for (const d of counterDays) {
    const date = d.day.toISOString().slice(0, 10);
    const n = (d.projectsCreated ?? 0) + (d.manualSaves ?? 0);
    if (n > 0) counts.set(date, (counts.get(date) ?? 0) + n);
  }

  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Heatmap for a public profile. Returns null unless the owner opted in via
 * preferences.showActivityHeatmap — enforced here, never by client hiding.
 * Applies to the owner too, so "view as others" shows exactly what others see.
 */
export async function getPublicActivityHeatmap(userId: string): Promise<ActivityHeatmapDay[] | null> {
  const prefs = await getPreferences(userId);
  if (!prefs.showActivityHeatmap) return null;
  return getUserActivityHeatmap(userId);
}
