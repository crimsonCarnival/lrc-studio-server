/**
 * streak-warning.job.ts
 *
 * Notifies users whose authoring streak ends at the next 00:00 UTC rollover:
 * streak.current >= STREAK_WARNING_MIN_STREAK, last active day = yesterday
 * (UTC), and nothing authored yet today (implied: lastActiveDate < today 00:00).
 *
 * Scheduling: the cron plugin calls this hourly; it only does work once the UTC
 * hour is >= STREAK_WARNING_HOUR_UTC, so a restart late in the day still sends.
 *
 * Idempotency: each user is claimed with a conditional update on
 * streak.warnedFor = today BEFORE the notification is created. A second run (or
 * a second instance) cannot claim the same user again. Trade-off: a crash
 * between claim and create drops that user's warning for the day
 * (at-most-once) rather than risking a duplicate.
 *
 * Exclusions: deleted, banned, and shadow-banned users; users who turned off
 * notifications.streak_warning (missing field = default on).
 */

import mongoose from 'mongoose';
import User from '../db/user.model.js';
import UserPreferences from '../db/user-preferences.model.js';
import Project from '../modules/projects/project.model.js';
import { notifyStreakWarning } from '../modules/notifications/notifications.service.js';

/** UTC hour after which warnings are sent (6h before the 00:00 UTC rollover). */
export const STREAK_WARNING_HOUR_UTC = 18;
/**
 * Minimum streak worth warning about. 1 would ping everyone who authored
 * anything once yesterday — noise with nothing meaningful to lose.
 */
export const STREAK_WARNING_MIN_STREAK = 2;

const BATCH_SIZE = 500;
const DAY_MS = 86_400_000;

type Candidate = { _id: mongoose.Types.ObjectId; streak?: { current?: number } };

export async function sendStreakWarnings(now: Date = new Date()): Promise<number> {
  if (now.getUTCHours() < STREAK_WARNING_HOUR_UTC) return 0;

  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  const today = todayStart.toISOString().slice(0, 10);

  // Range on streak.lastActiveDate is served by its index; the remaining
  // predicates filter that (small) range.
  const cursor = User.find({
    'streak.lastActiveDate': { $gte: yesterdayStart, $lt: todayStart },
    'streak.current': { $gte: STREAK_WARNING_MIN_STREAK },
    'streak.warnedFor': { $ne: today },
    isDeleted: { $ne: true },
    'ban.active': { $ne: true },
    'shadowBan.feed': { $ne: true },
    'shadowBan.search': { $ne: true },
  })
    .select('_id streak.current')
    .lean<Candidate[]>()
    .cursor({ batchSize: BATCH_SIZE });

  let sent = 0;
  let batch: Candidate[] = [];
  for await (const doc of cursor) {
    batch.push(doc as Candidate);
    if (batch.length >= BATCH_SIZE) {
      sent += await processBatch(batch, today);
      batch = [];
    }
  }
  if (batch.length > 0) sent += await processBatch(batch, today);
  return sent;
}

async function processBatch(batch: Candidate[], today: string): Promise<number> {
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
