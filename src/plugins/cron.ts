import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { archiveDeletedUsers } from '../jobs/archive-deleted-users.js';
import { recomputeTrendingScores } from '../jobs/trending.job.js';
import { recomputeLeaderboardRanking } from '../jobs/leaderboard-ranking.job.js';
import { syncRolePermissions } from '../modules/admin/admin.service.js';
import { sweepJobs } from '../modules/asr/job.store.js';
import { sendStreakWarnings } from '../jobs/streak-warning.job.js';
import { resetLapsedStreaks } from '../jobs/streak-lapse.job.js';
import { seedBuiltinBadges, runSyncStatsRefresh, SYNC_STATS_REFRESH_JOB } from '../modules/badges/badge.service.js';
import { seedAddictionLevels } from '../modules/stats/addiction-level.service.js';
import { syncSuperadminEmailGrant } from '../modules/auth/superadmin-env.service.js';
import { dropSupersededIndexes } from '../db/superseded-indexes.js';
import { startJobQueue, runJobQueue, stopJobQueue, defineRecurring, defineOnce } from '../lib/job-queue.js';

/**
 * Scheduled work. Recurring jobs run on the Mongo-backed job queue, so each
 * fires once across all instances and keeps its schedule across restarts.
 */

const HOUR_MS = 60 * 60 * 1000;

async function cronPlugin(fastify: FastifyInstance): Promise<void> {
  // Sync role permissions and seed code-defined defaults on startup
  fastify.addHook('onReady', async () => {
    await Promise.allSettled([
      syncRolePermissions()
        .then(() => fastify.log.info('[startup] Role permissions synced'))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to sync role permissions')),
      seedBuiltinBadges()
        .then((n) => fastify.log.info(`[startup] Built-in badges seeded (${n} inserted)`))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to seed built-in badges')),
      seedAddictionLevels()
        .then((n) => fastify.log.info(`[startup] Addiction levels seeded (${n} inserted)`))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to seed addiction levels')),
      syncSuperadminEmailGrant()
        .then(() => fastify.log.info('[startup] SUPERADMIN_EMAIL sync checked'))
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to sync SUPERADMIN_EMAIL grant')),
      dropSupersededIndexes()
        .then((dropped) => { if (dropped.length > 0) fastify.log.info(`[startup] Superseded indexes dropped: ${dropped.join(', ')}`); })
        .catch((err: unknown) => fastify.log.error({ err }, '[startup] Failed to drop superseded indexes')),
    ]);
  });

  fastify.addHook('onReady', async () => {
    try {
      await startJobQueue((err, jobName) => fastify.log.error({ err, jobName }, '[jobs] job failed'));

      // Weekly, Sunday 02:00 UTC.
      await defineRecurring('archive-deleted-users', '0 2 * * 0', archiveDeletedUsers);

      // Heavy aggregations — the reason these must not run once per instance.
      await defineRecurring('recompute-rankings', '1 hour', async () => {
        await recomputeTrendingScores();
        await recomputeLeaderboardRanking();
      });

      // Streak-ending warnings. The job itself no-ops before
      // STREAK_WARNING_HOUR_UTC and is idempotent per user per UTC day, so a
      // frequent tick only bounds the send delay (<= 15 min).
      await defineRecurring('streak-warnings', '15 minutes', async () => {
        const sent = await sendStreakWarnings();
        if (sent > 0) fastify.log.info(`[jobs] streak warnings sent: ${sent}`);
      });

      // Zero out streaks that have lapsed. updateStreak only rewrites
      // streak.current when a user is active again, so without this the stored
      // value keeps claiming a streak that getStreakView already reports as dead.
      await defineRecurring('streak-lapse', '15 minutes', async () => {
        const reset = await resetLapsedStreaks();
        if (reset > 0) fastify.log.info(`[jobs] lapsed streaks reset: ${reset}`);
      });

      defineOnce(SYNC_STATS_REFRESH_JOB, runSyncStatsRefresh);

      await runJobQueue();
      fastify.log.info('[jobs] job queue started');
    } catch (err) {
      fastify.log.error({ err }, '[jobs] failed to start job queue — scheduled jobs are not running');
    }
  });

  // The ASR job store is a per-process Map, so its sweep has to run in every
  // instance and cannot move to the shared queue.
  const asrSweepTimer = setInterval(sweepJobs, HOUR_MS);
  asrSweepTimer.unref();

  fastify.addHook('onClose', async () => {
    clearInterval(asrSweepTimer);
    await stopJobQueue();
  });
}

export default fp(cronPlugin, { name: 'cron', dependencies: ['mongoose'] });
