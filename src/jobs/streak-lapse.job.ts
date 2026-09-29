/**
 * streak-lapse.job.ts
 *
 * Zeroes `streak.current` for users whose authoring streak has lapsed.
 *
 * Why this exists: `updateStreak` only rewrites `streak.current` when a user is
 * active again, so a streak broken days ago keeps its old value in the database
 * indefinitely. Reads were already correct — `getStreakView` recomputes liveness
 * and reports 0 for a lapsed streak — but the stored document still said e.g.
 * `current: 5`, which is actively misleading to anyone inspecting the data,
 * writing an aggregation, or debugging a "why does the UI disagree" report.
 *
 * A streak is alive when its last active UTC day is today or yesterday, matching
 * getStreakView exactly. Anything older is lapsed and gets reset to 0.
 * `streak.longest` is never touched — that is the historical record.
 *
 * Scheduling: hourly, alongside the streak warning job. Running it more often
 * than once a day is harmless and means a lapse is reflected soon after the UTC
 * rollover rather than up to 24h later.
 *
 * Idempotency: the filter only matches documents that still need changing, so a
 * second run in the same hour updates nothing.
 */
import User from '../db/user.model.js';

/**
 * Reset every lapsed streak. Returns how many users were changed.
 *
 * @param now injectable for tests; defaults to the current time.
 */
export async function resetLapsedStreaks(now: Date = new Date()): Promise<number> {
  // Start of yesterday, UTC. A lastActiveDate before this instant cannot be
  // "today or yesterday", so the streak is dead.
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));

  const result = await User.updateMany(
    {
      'streak.current': { $gt: 0 },
      $or: [
        { 'streak.lastActiveDate': { $lt: cutoff } },
        { 'streak.lastActiveDate': null },
        { 'streak.lastActiveDate': { $exists: false } },
      ],
    },
    { $set: { 'streak.current': 0 } },
  );

  return result.modifiedCount ?? 0;
}
