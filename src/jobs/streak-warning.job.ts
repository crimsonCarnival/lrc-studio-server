/**
 * streak-warning.job.ts
 *
 * Notifies users whose streak ends at their next local midnight: streak.current >=
 * STREAK_WARNING_MIN_STREAK, their last active day (in their own timezone) was yesterday, and it
 * is at least STREAK_WARNING_HOUR_LOCAL on their clock today with nothing authored yet today.
 *
 * Scheduling: the cron plugin calls this every 15 minutes. Days and hours are per user
 * (streak.timezone, UTC when unset), so the query only narrows to users active in the last three
 * days (served by the lastActiveDate index) and the local-time tests run per user in memory.
 *
 * Idempotency: each user is claimed with a conditional update on
 * streak.warnedFor = their local day BEFORE the notification is created. A second run (or
 * a second instance) cannot claim the same user again. Trade-off: a crash
 * between claim and create drops that user's warning for the day
 * (at-most-once) rather than risking a duplicate.
 *
 * Exclusions: deleted, banned, and shadow-banned users; users who turned off
 * notifications.streak_warning (missing field = default on).
 */

import mongoose from 'mongoose';
import User from '../modules/users/user.model.js';
import UserPreferences from '../modules/user-preferences/user-preferences.model.js';
import Project from '../modules/projects/project.model.js';
import { zonedDayKey, zonedHour, prevDayKey } from '../shared/zoned-day.js';
import { notifyStreakWarning } from '../modules/notifications/notifications.service.js';

/** Local hour of day after which warnings are sent (6h before the user's midnight). */
export const STREAK_WARNING_HOUR_LOCAL = 18;
/**
 * Minimum streak worth warning about. 1 would ping everyone who authored
 * anything once yesterday — noise with nothing meaningful to lose.
 */
export const STREAK_WARNING_MIN_STREAK = 2;

const BATCH_SIZE = 500;
const DAY_MS = 86_400_000;

type Candidate = { _id: mongoose.Types.ObjectId; streak?: { current?: number; lastActiveDate?: Date | null; timezone?: string | null; warnedFor?: string | null } };

export async function sendStreakWarnings(now: Date = new Date()): Promise<number> {
  // Widest offsets put "yesterday" up to ~38 h back; three days covers every zone with margin.
  const since = new Date(now.getTime() - 3 * DAY_MS);
  const cursor = User.find({
    'streak.lastActiveDate': { $gte: since, $lt: now },
    'streak.current': { $gte: STREAK_WARNING_MIN_STREAK },
    isDeleted: { $ne: true },
    'ban.active': { $ne: true },
    'shadowBan.feed': { $ne: true },
    'shadowBan.search': { $ne: true },
  })
    .select('_id streak.current streak.lastActiveDate streak.timezone streak.warnedFor')
    .lean<Candidate[]>()
    .cursor({ batchSize: BATCH_SIZE });

  let sent = 0;
  let batch: Candidate[] = [];
  for await (const doc of cursor) {
    const c = doc as Candidate;
    const tz = c.streak?.timezone;
    if (zonedHour(now, tz) < STREAK_WARNING_HOUR_LOCAL) continue;
    const today = zonedDayKey(now, tz);
    const last = c.streak?.lastActiveDate;
    // Active yesterday and not yet today (local days), and not already warned for today.
    if (!last || zonedDayKey(new Date(last), tz) !== prevDayKey(today)) continue;
    if (c.streak?.warnedFor === today) continue;
    batch.push(c);
    if (batch.length >= BATCH_SIZE) {
      sent += await processBatch(batch, now);
      batch = [];
    }
  }
  if (batch.length > 0) sent += await processBatch(batch, now);
  return sent;
}

async function processBatch(batch: Candidate[], now: Date): Promise<number> {
  const ids = batch.map(u => u._id);

  const [optedOut, lastProjects] = await Promise.all([
    UserPreferences.find({ userId: { $in: ids }, 'notifications.streak_warning': false })
      .select('userId')
      .lean<{ userId: mongoose.Types.ObjectId }[]>(),
    // Most recently updated project per user — { userId, updatedAt } index.
    Project.aggregate<{ _id: mongoose.Types.ObjectId; publicId: string; title: string | null }>([
      { $match: { userId: { $in: ids } } },
      { $sort: { userId: 1, updatedAt: -1 } },
      { $group: { _id: '$userId', publicId: { $first: '$publicId' }, title: { $first: '$title' } } },
    ]),
  ]);

  const optedOutSet = new Set(optedOut.map(p => p.userId.toString()));
  const projectByUser = new Map(lastProjects.map(p => [p._id.toString(), p]));

  let sent = 0;
  for (const user of batch) {
    const userId = user._id.toString();
    if (optedOutSet.has(userId)) continue;
    const today = zonedDayKey(now, user.streak?.timezone);

    // Atomic claim: only one run/instance can flip warnedFor to today.
    const claim = await User.updateOne(
      { _id: user._id, 'streak.warnedFor': { $ne: today } },
      { $set: { 'streak.warnedFor': today } },
    );
    if (claim.modifiedCount !== 1) continue;

    const project = projectByUser.get(userId);
    try {
      await notifyStreakWarning({
        userId,
        current: user.streak?.current ?? 0,
        day: today,
        publicId: project?.publicId ?? null,
        projectTitle: project?.title ?? null,
      });
      sent++;
    } catch {
      // Claimed but not delivered: accepted at-most-once loss (see header).
    }
  }
  return sent;
}
