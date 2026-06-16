import 'dotenv/config';
import mongoose from 'mongoose';
import dns from 'node:dns';
import User from '../db/user.model.js';
import XPEvent from '../modules/progression/xp-event.model.js';
import BadgeDefinition from '../modules/badges/badge-definition.model.js';
import type { IUser, IUserBadge } from '../db/user.model.js';
import type { IBadgeDefinition } from '../modules/badges/badge-definition.model.js';

dns.setServers(['1.1.1.1', '8.8.8.8']);

const XP_COEFFICIENTS = {
  minutesSynced: 3,
  wordsSynced: 0.25,
  karaokeLines: 0.5,
  starsReceived: 3,
  forksReceived: 5,
  followerCount: 1.5,
};

const BUILTIN_XP = new Map([
  ['og', 750],
  ['pioneer', 200],
  ['syncer10h', 200],
  ['syncer100h', 1000],
  ['wordsmith1k', 300],
  ['wordsmith50k', 1500],
  ['karaoke100', 250],
  ['karaoke1k', 800],
  ['century', 600],
  ['published10', 150],
  ['beloved', 250],
  ['influential', 200],
  ['following50', 100],
  ['uploader', 150],
  ['veteran', 300],
  ['streak7', 100],
  ['streak30', 300],
  ['verified', 50],
  ['admin', 500],
]);

async function computeXPFromStats(
  badgeXp: number,
  stats: { minutesSynced?: number; wordsSynced?: number; karaokeLines?: number },
  social?: { totalStarsReceived?: number; totalForksReceived?: number; followerCount?: number }
): Promise<number> {
  const mins = stats?.minutesSynced ?? 0;
  const words = stats?.wordsSynced ?? 0;
  const karaoke = stats?.karaokeLines ?? 0;
  const stars = social?.totalStarsReceived ?? 0;
  const forks = social?.totalForksReceived ?? 0;
  const followers = social?.followerCount ?? 0;

  const craftXp = mins * XP_COEFFICIENTS.minutesSynced +
                  words * XP_COEFFICIENTS.wordsSynced +
                  karaoke * XP_COEFFICIENTS.karaokeLines;

  const communityXp = stars * XP_COEFFICIENTS.starsReceived +
                      forks * XP_COEFFICIENTS.forksReceived +
                      followers * XP_COEFFICIENTS.followerCount;

  return Math.max(0, Math.floor(badgeXp + craftXp + communityXp));
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI env var is required');
  await mongoose.connect(uri);

  console.log('🔄 Starting XP migration to event-based system...\n');

  // Check if events already exist (idempotent check)
  const existingEvents = await XPEvent.countDocuments({});
  if (existingEvents > 100) {
    console.log(`⚠️  Found ${existingEvents} existing XP events. Migration may have already run.`);
    console.log('   Proceeding anyway (idempotent)...\n');
  }

  const users = await User.find({ isDeleted: { $ne: true } })
    .select('_id badges stats social progression')
    .lean<IUser[]>();

  console.log(`📊 Processing ${users.length} users...\n`);

  let updated = 0;
  let errors = 0;
  const batchSize = 10;

  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);

    await Promise.all(batch.map(async (user) => {
      try {
        // Compute badge XP
        const badgeIds = (user.badges ?? []).map((b: IUserBadge) => b.id);
        let badgeXp = 0;
        const customIds = badgeIds.filter(id => !BUILTIN_XP.has(id));

        if (customIds.length > 0) {
          const customDefs = await BadgeDefinition.find({ id: { $in: customIds } })
            .select('id xpReward')
            .lean<Pick<IBadgeDefinition, 'id' | 'xpReward'>[]>();
          const customMap = new Map(customDefs.map(d => [d.id, d.xpReward ?? 50]));
          for (const id of badgeIds) {
            badgeXp += BUILTIN_XP.get(id) ?? customMap.get(id) ?? 50;
          }
        } else {
          for (const id of badgeIds) {
            badgeXp += BUILTIN_XP.get(id) ?? 50;
          }
        }

        const newXp = await computeXPFromStats(badgeXp, user.stats ?? {}, user.social);
        const oldXp = user.progression?.xp ?? 0;

        // Create backfill event
        await XPEvent.create({
          userId: user._id,
          type: 'backfill',
          source: 'migration',
          delta: newXp - oldXp,
          totalXpAfter: newXp,
          reason: `Backfill from old formula: ${oldXp} → ${newXp}`,
          createdAt: new Date(),
        });

        updated++;
      } catch (err) {
        console.error(`❌ Error processing user ${user._id}:`, err instanceof Error ? err.message : err);
        errors++;
      }
    }));

    const percent = Math.round(((i + batchSize) / users.length) * 100);
    console.log(`  [${percent}%] Processed ${Math.min(i + batchSize, users.length)}/${users.length} users`);
  }

  console.log(`\n✅ Migration complete!`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Errors: ${errors}`);

  // Validation sample
  console.log('\n🔍 Validating integrity for sample users...');
  const samples = users.slice(0, Math.min(5, users.length));
  let valid = 0;
  for (const user of samples) {
    const events = await XPEvent.find({ userId: user._id })
      .sort({ createdAt: 1 })
      .lean<any[]>();
    const calculated = events.length > 0 ? events[events.length - 1].totalXpAfter : 0;
    const stored = user.progression?.xp ?? 0;
    if (stored === calculated) {
      console.log(`   ✓ User ${user._id}: ${stored} XP (validated)`);
      valid++;
    } else {
      console.log(`   ✗ User ${user._id}: stored=${stored}, calculated=${calculated}`);
    }
  }
  console.log(`   Validation: ${valid}/${samples.length} users correct\n`);

  await mongoose.connection.close();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
