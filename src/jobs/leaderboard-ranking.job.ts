/**
 * leaderboard-ranking.job.ts
 *
 * Computes a weighted-percentile ranking score (0–1000) for every active user
 * and persists it to user.rankScore so the leaderboard resolver can do a cheap
 * indexed sort instead of a runtime aggregation.
 *
 * Algorithm (runs hourly alongside trending score recomputation):
 *   1. Load all active users with stats, social, streak, projectCount.
 *   2. For each of the 8 metrics, collect all values into a sorted array.
 *   3. For each user, compute their percentile per metric (fraction of users
 *      whose value is ≤ this user's value, via binary search).
 *   4. Score = Σ (weight_i × percentile_i) × 1000   (rounds to 2dp).
 *   5. Bulk-write rankScore back to MongoDB atomically.
 *
 * Diminishing-returns transform:
 *   Volume metrics (lines, words, karaoke) use sqrt() before percentile
 *   calculation so spamming trivial content yields logarithmically smaller gains.
 *
 * Eligibility floor:
 *   A user must have ≥ 1 synced line OR ≥ 1 second of synced time to appear in
 *   the ranking pool. Everyone else gets rankScore = 0 (sorted to the bottom).
 *
 * Anti-fraud note:
 *   This job computes merit scores only. Fraud signals (rate-limiting, duplicate
 *   IP/account detection, velocity checks) are a separate eligibility layer that
 *   can exclude users before this job runs.
 */

import mongoose from 'mongoose';
import User from '../db/user.model.js';
import Project from '../modules/projects/project.model.js';

// ─── Weights (must sum to 1.0) ────────────────────────────────────────────────

const WEIGHTS = {
  timeSynced:   0.18,  // total seconds (minutesSynced×60 + secondsSynced)
  syncedLines:  0.15,  // sqrt(syncedLines)
  stars:        0.15,  // social.totalStarsReceived
  wordsSynced:  0.15,  // sqrt(wordsSynced)
  karaokeLines: 0.13,  // sqrt(karaokeLines)
  forks:        0.10,  // social.totalForksReceived
  projects:     0.08,  // project count
  streak:       0.06,  // streak.current
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Binary search: returns the index where `value` would be inserted to keep
 * the sorted array in ascending order (leftmost position). O(log n).
 */
function bisectLeft(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Returns a percentile score in [0, 1]:
 * the fraction of eligible users whose value is ≤ this user's value.
 * Returns 0 when pool has 0 or 1 members (no meaningful comparison).
 */
function computePercentile(sorted: number[], value: number): number {
  if (sorted.length <= 1) return 0;
  const rank = bisectLeft(sorted, value);
  return Math.min(rank / (sorted.length - 1), 1);
}

type MetricKey = keyof typeof WEIGHTS;

interface LeanUserForRanking {
  _id: mongoose.Types.ObjectId;
  stats?: {
    minutesSynced?: number;
    secondsSynced?: number;
    wordsSynced?: number;
    karaokeLines?: number;
    syncedLines?: number;
  };
  social?: {
    totalStarsReceived?: number;
    totalForksReceived?: number;
  };
  streak?: { current?: number };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function recomputeLeaderboardRanking(): Promise<void> {
  // 1. Load all active, non-deleted users
  const users = await User.find({ isDeleted: { $ne: true } })
    .select('_id stats social streak')
    .lean<LeanUserForRanking[]>();

  if (users.length === 0) return;

  // 2. Resolve project counts via aggregation
  const projectAgg = await Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { userId: { $in: users.map(u => u._id) } } },
    { $group: { _id: '$userId', count: { $sum: 1 } } },
  ]);
  const projectCountMap = new Map<string, number>(
    projectAgg.map(r => [r._id.toString(), r.count])
  );

  // 3. Build raw (transformed) metric values per user
  type UserMetrics = Record<MetricKey, number>;
  const userMetrics: Array<{ id: string; metrics: UserMetrics; eligible: boolean }> = users.map(u => {
    const timeSynced   = (u.stats?.minutesSynced ?? 0) * 60 + (u.stats?.secondsSynced ?? 0);
    const syncedLines  = u.stats?.syncedLines ?? 0;
    const wordsSynced  = u.stats?.wordsSynced ?? 0;
    const karaokeLines = u.stats?.karaokeLines ?? 0;
    const stars        = u.social?.totalStarsReceived ?? 0;
    const forks        = u.social?.totalForksReceived ?? 0;
    const projects     = projectCountMap.get(u._id.toString()) ?? 0;
    const streak       = u.streak?.current ?? 0;

    // Eligibility floor: user must have some real activity
    const eligible = syncedLines >= 1 || timeSynced >= 1;

    return {
      id: u._id.toString(),
      eligible,
      metrics: {
        timeSynced,
        syncedLines:  Math.sqrt(syncedLines),   // diminishing returns on volume
        wordsSynced:  Math.sqrt(wordsSynced),   // diminishing returns on volume
        karaokeLines: Math.sqrt(karaokeLines),  // diminishing returns on volume
        stars,
        forks,
        projects,
        streak,
      },
    };
  });

  // 4. Build sorted pools from eligible users only
  const sortedPools: Record<MetricKey, number[]> = {
    timeSynced:   [],
    syncedLines:  [],
    wordsSynced:  [],
    karaokeLines: [],
    stars:        [],
    forks:        [],
    projects:     [],
    streak:       [],
  };

  for (const u of userMetrics) {
    if (!u.eligible) continue;
    for (const key of Object.keys(WEIGHTS) as MetricKey[]) {
      sortedPools[key].push(u.metrics[key]);
    }
  }

  for (const key of Object.keys(WEIGHTS) as MetricKey[]) {
    sortedPools[key].sort((a, b) => a - b);
  }

  // 5. Compute score for each user and queue bulk write
  type BulkOp = {
    updateOne: {
      filter: { _id: mongoose.Types.ObjectId };
      update: { $set: { rankScore: number } };
    };
  };
  const bulkOps: BulkOp[] = [];

  for (const u of userMetrics) {
    let score = 0;
    if (u.eligible) {
      for (const key of Object.keys(WEIGHTS) as MetricKey[]) {
        const pct = computePercentile(sortedPools[key], u.metrics[key]);
        score += WEIGHTS[key] * pct;
      }
    }
    // Multiply by 10,000 (no artificial ceiling), round to 2 decimal places
    const rankScore = Math.round(score * 10000 * 100) / 100;

    bulkOps.push({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(u.id) },
        update: { $set: { rankScore } },
      },
    });
  }

  // 6. Write all scores atomically
  if (bulkOps.length > 0) {
    await User.bulkWrite(bulkOps, { ordered: false });
  }
}
