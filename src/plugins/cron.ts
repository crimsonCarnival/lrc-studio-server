import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { archiveDeletedUsers } from '../jobs/archive-deleted-users.js';
import { recomputeTrendingScores } from '../jobs/trending.job.js';
import { recomputeLeaderboardRanking } from '../jobs/leaderboard-ranking.job.js';
import { seedAddictionLevels } from '../modules/stats/addiction-level.service.js';
import { seedBuiltinBadges } from '../modules/badges/badge.service.js';
import { syncRolePermissions } from '../modules/admin/admin.service.js';
import { sweepJobs } from '../modules/asr/job.store.js';

/**
 * Lightweight cron-like scheduler using setInterval.
 * Runs archiveDeletedUsers weekly on Sunday at 02:00 UTC.
 *
 * NOTE: node-cron and fastify-cron are not installed. If a proper cron library
 * is desired in the future, add `node-cron` to dependencies and replace this
 * implementation with: cron.schedule('0 2 * * 0', archiveDeletedUsers).
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Returns milliseconds until next Sunday 02:00 UTC. */
function msUntilNextSunday0200(): number {
  const now = new Date();
  const next = new Date(now);
  // Find next Sunday (day 0) at 02:00 UTC
  const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7; // at least 1 week if today is Sunday
  next.setUTCDate(now.getUTCDate() + daysUntilSunday);
  next.setUTCHours(2, 0, 0, 0);
  return next.getTime() - now.getTime();
}

async function cronPlugin(fastify: FastifyInstance): Promise<void> {
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let weeklyTimer: ReturnType<typeof setInterval> | null = null;

  fastify.addHook('onReady', async () => {
    const runAndReschedule = async () => {
      try {
        await archiveDeletedUsers();
      } catch (err) {
        fastify.log.error({ err }, '[cron] archiveDeletedUsers failed');
      }
    };

    // Schedule first run at the next Sunday 02:00 UTC, then repeat weekly
    const initialDelay = msUntilNextSunday0200();
    fastify.log.info(
      `[cron] archiveDeletedUsers scheduled in ${Math.round(initialDelay / 1000 / 60)} minutes`
    );

    initialTimer = setTimeout(() => {
      initialTimer = null;
      void runAndReschedule();
      weeklyTimer = setInterval(runAndReschedule, WEEK_MS);
    }, initialDelay);
  });

  let trendingTimer: ReturnType<typeof setInterval> | null = null;

  // Seed built-in badges and addiction levels on startup (idempotent — $set merges Spanish strings)
  fastify.addHook('onReady', async () => {
    await Promise.allSettled([
      seedBuiltinBadges()
        .then(() => fastify.log.info('[startup] Built-in badges seeded'))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to seed built-in badges')),
      seedAddictionLevels()
        .then(() => fastify.log.info('[startup] Addiction levels seeded'))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to seed addiction levels')),
      syncRolePermissions()
        .then(() => fastify.log.info('[startup] Role permissions synced'))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to sync role permissions')),
    ]);
  });

  fastify.addHook('onReady', async () => {
    const runTrending = async () => {
      try {
        sweepJobs();
        await recomputeTrendingScores();
        await recomputeLeaderboardRanking();
      } catch (err) {
        fastify.log.error({ err }, '[cron] recomputeTrendingScores failed');
      }
    };
    // Fire without awaiting — heavy aggregation job, runs in background after server is up
    void runTrending();
    trendingTimer = setInterval(runTrending, HOUR_MS);
  });

  fastify.addHook('onClose', async () => {
    if (initialTimer !== null) clearTimeout(initialTimer);
    if (weeklyTimer !== null) clearInterval(weeklyTimer);
    if (trendingTimer !== null) clearInterval(trendingTimer);
  });
}

export default fp(cronPlugin, { name: 'cron', dependencies: ['mongoose'] });
