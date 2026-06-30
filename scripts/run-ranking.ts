/**
 * run-ranking.ts
 *
 * Runs the leaderboard-ranking.job.ts once to backfill the rankScore
 * for all users.
 *
 * Run with:
 *   npx ts-node --esm scripts/run-ranking.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { recomputeLeaderboardRanking } from '../src/jobs/leaderboard-ranking.job.js';

const MONGO_URI = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? '';
if (!MONGO_URI) {
  console.error('❌  No MONGODB_URI env var found.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅  Connected to MongoDB');

  console.log('🔄  Computing and writing leaderboard ranking scores…');
  const start = Date.now();
  await recomputeLeaderboardRanking();
  const elapsed = Date.now() - start;

  console.log(`✅  Done in ${elapsed}ms.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
