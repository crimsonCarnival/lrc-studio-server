import mongoose from 'mongoose';
import Activity, { type ActivityType } from '../../db/activity.model.js';
import Follow from '../../db/follow.model.js';
import HeatmapDay, { type IHeatmapDay } from '../../db/heatmap-day.model.js';
import HeatmapProjectEdit from '../../db/heatmap-project-edit.model.js';
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

export type HeatmapEventKind = 'project_created' | 'project_edited';

function startOfUtcDay(date: Date): Date {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

async function incrementHeatmapDay(
  userId: mongoose.Types.ObjectId,
  day: Date,
  field: 'projectsCreated' | 'editedProjects'
): Promise<void> {
  const filter = { userId, day };
  const update = { $inc: { [field]: 1 } };
  try {
    await HeatmapDay.updateOne(filter, update, { upsert: true });
  } catch (err) {
    // Two concurrent upserts creating the same (user, day) doc: one loses on the
    // unique index. The doc now exists, so a single retry takes the update path.
    if (!isDuplicateKeyError(err)) throw err;
    await HeatmapDay.updateOne(filter, update, { upsert: true });
  }
}

/**
 * Counts a private authoring event (project creation, or a save that actually
 * changed content — manual or auto) toward the owner's heatmap. Both event
 * kinds count DISTINCT PROJECTS per day, not raw events: `heatmap_project_edits`
 * gates the write with an insert-and-swallow-duplicate check on
 * (userId, projectId, day) BEFORE any counter is touched, so:
 *   - ticking autosave on the same project all day only contributes once
 *   - a project created today that's also edited today contributes once
 *     total (the creation's insert wins the dedup row; the later edit's
 *     insert finds it and is a no-op)
 * This insert-first-then-increment order (rather than read-then-write) is
 * what makes concurrent saves of the same project race-safe: only the
 * request whose insert succeeds proceeds to $inc, so two simultaneous
 * autosaves for the same project can never both increment.
 * Writes only to heatmap_days / heatmap_project_edits — never to
 * `activities` — so private authoring events can't reach the social feed.
 */
export async function recordHeatmapEvent(
  userId: string,
  kind: HeatmapEventKind,
  projectId: string,
  now: Date = new Date()
): Promise<void> {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const day = startOfUtcDay(now);

  try {
    await HeatmapProjectEdit.create({ userId: userObjectId, projectId, day });
  } catch (err) {
    if (isDuplicateKeyError(err)) return; // this project already counted for today
    throw err;
  }

  await incrementHeatmapDay(userObjectId, day, kind === 'project_created' ? 'projectsCreated' : 'editedProjects');
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
      .select('day projectsCreated editedProjects -_id')
      .lean<Pick<IHeatmapDay, 'day' | 'projectsCreated' | 'editedProjects'>[]>(),
  ]);

  const counts = new Map<string, number>();
  for (const d of socialDays) counts.set(d.date, d.count);
  for (const d of counterDays) {
    const date = d.day.toISOString().slice(0, 10);
    const n = (d.projectsCreated ?? 0) + (d.editedProjects ?? 0);
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
