import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import BadgeDefinition from './badge-definition.model.js';
import Notification from '../notifications/notification.model.js';
import { getIO } from '../../socket/socket.manager.js';

// ─── Builtin seed data ────────────────────────────────────────────────────────

export const BUILTIN_BADGES = [
  { id: 'og',          label: 'Side A',         description: 'One of the first 100 users to join',       icon: '🏆', color: 'amber',   conditionType: 'registration_rank',    conditionValue: 100,   autoGrant: true, isBuiltin: true, xpReward: 500 },
  { id: 'pioneer',     label: 'Debut',          description: 'Among the first 1,000 users',              icon: '🚀', color: 'teal',    conditionType: 'registration_rank',    conditionValue: 1000,  autoGrant: true, isBuiltin: true, xpReward: 100 },
  { id: 'syncer10h',   label: 'Open Mic',       description: 'Synced at least 10 hours of lyrics',       icon: '🎵', color: 'green',   conditionType: 'minutes_synced',       conditionValue: 600,   autoGrant: true, isBuiltin: true, xpReward: 100 },
  { id: 'syncer100h',  label: 'World Tour',     description: 'Synced at least 100 hours of lyrics',      icon: '🎶', color: 'green',   conditionType: 'minutes_synced',       conditionValue: 6000,  autoGrant: true, isBuiltin: true, xpReward: 350 },
  { id: 'wordsmith1k', label: 'Verse One',      description: 'Timestamped 1,000 individual words',       icon: '✍️', color: 'blue',    conditionType: 'words_synced',         conditionValue: 1000,  autoGrant: true, isBuiltin: true, xpReward: 125 },
  { id: 'wordsmith50k',label: 'Grand Opus',     description: 'Timestamped 50,000 individual words',      icon: '📖', color: 'shimmer', conditionType: 'words_synced',         conditionValue: 50000, autoGrant: true, isBuiltin: true, xpReward: 350 },
  { id: 'karaoke100',  label: 'On Stage',       description: 'Word-synced 100 lyric lines',              icon: '🎤', color: 'orange',  conditionType: 'karaoke_lines',        conditionValue: 100,   autoGrant: true, isBuiltin: true, xpReward: 100 },
  { id: 'karaoke1k',   label: 'Headliner',      description: 'Word-synced 1,000 lyric lines',            icon: '🌟', color: 'amber',   conditionType: 'karaoke_lines',        conditionValue: 1000,  autoGrant: true, isBuiltin: true, xpReward: 250 },
  { id: 'century',     label: 'Anthology',      description: 'Created 100+ projects',                    icon: '💫', color: 'shimmer', conditionType: 'project_count',        conditionValue: 100,   autoGrant: true, isBuiltin: true, xpReward: 200 },
  { id: 'published10', label: 'In Rotation',    description: 'Published 10 public projects',             icon: '📢', color: 'teal',    conditionType: 'public_project_count', conditionValue: 10,    autoGrant: true, isBuiltin: true, xpReward: 100 },
  { id: 'beloved',     label: 'Gold Record',    description: 'Received 50 stars on your work',           icon: '⭐', color: 'amber',   conditionType: 'stars_received',       conditionValue: 50,    autoGrant: true, isBuiltin: true, xpReward: 200 },
  { id: 'influential', label: 'Sampled',        description: 'Your work has been forked 25 times',       icon: '🌿', color: 'green',   conditionType: 'forks_received',       conditionValue: 25,    autoGrant: true, isBuiltin: true, xpReward: 250 },
  { id: 'following50', label: 'Fan Base',       description: 'Reached 50 followers',                     icon: '🤝', color: 'primary', conditionType: 'follower_count',       conditionValue: 50,    autoGrant: true, isBuiltin: true, xpReward: 125 },
  { id: 'uploader',    label: 'Studio Ready',   description: 'Uploaded 10 media files',                  icon: '📤', color: 'blue',    conditionType: 'upload_count',         conditionValue: 10,    autoGrant: true, isBuiltin: true, xpReward: 50  },
  { id: 'veteran',     label: 'Session Player', description: 'Account is at least 1 year old',           icon: '🎖️', color: 'rose',   conditionType: 'account_age_days',     conditionValue: 365,   autoGrant: true, isBuiltin: true, xpReward: 150 },
  { id: 'streak7',     label: 'Daily Mix',      description: '7-day activity streak',                    icon: '🔥', color: 'orange',  conditionType: 'streak_days',          conditionValue: 7,     autoGrant: true, isBuiltin: true, xpReward: 50  },
  { id: 'streak30',    label: 'Extended Play',  description: '30-day activity streak',                   icon: '⚡', color: 'amber',   conditionType: 'streak_days',          conditionValue: 30,    autoGrant: true, isBuiltin: true, xpReward: 150 },
  { id: 'verified',    label: 'In Key',         description: 'Verified email address',                   icon: '✓',  color: 'primary', conditionType: 'is_verified',          conditionValue: null,  autoGrant: true, isBuiltin: true, xpReward: 25  },
  { id: 'admin',       label: 'A&R',            description: 'Platform administrator',                   icon: '🛡️', color: 'rose',   conditionType: 'role_admin',           conditionValue: null,  autoGrant: true, isBuiltin: true, xpReward: 500 },
];

// Seeds built-in badges to DB — called on server startup.
// $setOnInsert: display fields (label, description, icon, color) so admin edits survive redeployment.
// $set: xpReward only — always synced from code so balance changes deploy immediately.
export async function seedBuiltinBadges(): Promise<void> {
  for (const { id, label, description, icon, color, conditionType, conditionValue, autoGrant, isBuiltin, xpReward } of BUILTIN_BADGES) {
    await BadgeDefinition.findOneAndUpdate(
      { id },
      {
        $setOnInsert: { id, label, description, icon, color, conditionType, conditionValue, autoGrant, isBuiltin },
        $set: { xpReward },
      },
      { upsert: true }
    );
  }
}

// ─── Event → condition types mapping ─────────────────────────────────────────

export type BadgeEvent =
  | 'registration'
  | 'sync_update'
  | 'project_create'
  | 'project_publish'
  | 'star_received'
  | 'fork_received'
  | 'follow_received'
  | 'upload_create'
  | 'email_verified'
  | 'role_change'
  | 'daily_cron';

const EVENT_CONDITIONS: Record<BadgeEvent, string[]> = {
  registration:    ['registration_rank', 'account_age_days', 'is_verified', 'role_admin'],
  sync_update:     ['minutes_synced', 'words_synced', 'karaoke_lines', 'streak_days'],
  project_create:  ['project_count', 'streak_days'],
  project_publish: ['public_project_count'],
  star_received:   ['stars_received'],
  fork_received:   ['forks_received'],
  follow_received: ['follower_count'],
  upload_create:   ['upload_count'],
  email_verified:  ['is_verified'],
  role_change:     ['role_admin'],
  daily_cron:      ['account_age_days', 'streak_days'],
};

// ─── Condition evaluation ─────────────────────────────────────────────────────

export async function checkCondition(user: any, def: any): Promise<boolean> {
  switch (def.conditionType) {
    case 'registration_rank': {
      const rank = await User.countDocuments({ createdAt: { $lte: user.createdAt } });
      return rank <= def.conditionValue;
    }
    case 'minutes_synced':
      return (user.minutesSynced ?? 0) >= def.conditionValue;
    case 'words_synced':
      return (user.wordsSynced ?? 0) >= def.conditionValue;
    case 'karaoke_lines':
      return (user.karaokeLines ?? 0) >= def.conditionValue;
    case 'project_count': {
      const n = await Project.countDocuments({ userId: user._id });
      return n >= def.conditionValue;
    }
    case 'public_project_count': {
      const n = await Project.countDocuments({ userId: user._id, public: true });
      return n >= def.conditionValue;
    }
    case 'stars_received':
      return (user.social?.totalStarsReceived ?? 0) >= def.conditionValue;
    case 'forks_received':
      return (user.social?.totalForksReceived ?? 0) >= def.conditionValue;
    case 'follower_count':
      return (user.social?.followerCount ?? 0) >= def.conditionValue;
    case 'upload_count': {
      const n = await Upload.countDocuments({ userId: user._id });
      return n >= def.conditionValue;
    }
    case 'account_age_days': {
      const days = (Date.now() - new Date(user.createdAt).getTime()) / 86400000;
      return days >= def.conditionValue;
    }
    case 'streak_days':
      return (user.currentStreak ?? 0) >= def.conditionValue;
    case 'is_verified':
      return user.isVerified === true;
    case 'role_admin':
      return user.role === 'admin';
    case 'manual':
      return false;
    default:
      return false;
  }
}

// ─── Core grant/revoke ────────────────────────────────────────────────────────

export async function grantBadge(
  userId: string,
  badgeId: string,
  grantedBy: string = 'system'
): Promise<boolean> {
  const result = await User.findOneAndUpdate(
    { _id: userId, 'badges.id': { $ne: badgeId } },
    { $push: { badges: { id: badgeId, grantedAt: new Date(), grantedBy } } },
    { new: true }
  );
  if (!result) return false; // already had it or user not found

  notifyBadgeAwarded(userId, badgeId).catch(() => {});
  recomputeXP(userId).catch(() => {});
  return true;
}

export async function revokeBadge(userId: string, badgeId: string): Promise<boolean> {
  const result = await User.updateOne(
    { _id: userId },
    { $pull: { badges: { id: badgeId } } }
  );
  if ((result.modifiedCount ?? 0) > 0) {
    // Also remove from showcase if present
    await User.updateOne({ _id: userId }, { $pull: { showcasedBadges: badgeId } });
    recomputeXP(userId).catch(() => {});
    return true;
  }
  return false;
}

// ─── Badge trigger (called after events) ─────────────────────────────────────

export async function triggerBadgeCheck(userId: string, event: BadgeEvent): Promise<string[]> {
  const relevantConditions = EVENT_CONDITIONS[event] ?? [];
  if (relevantConditions.length === 0) return [];

  const [user, defs] = await Promise.all([
    User.findById(userId).lean(),
    BadgeDefinition.find({ autoGrant: true, conditionType: { $in: relevantConditions } }).lean(),
  ]);
  if (!user) return [];

  const existingIds = new Set<string>(((user as any).badges ?? []).map((b: any) => b.id));
  const granted: string[] = [];

  for (const def of defs) {
    if (existingIds.has((def as any).id)) continue;
    const qualifies = await checkCondition(user, def);
    if (qualifies) {
      const ok = await grantBadge(userId, (def as any).id, 'system');
      if (ok) granted.push((def as any).id);
    }
  }

  return granted;
}

// ─── Retroactive scan ─────────────────────────────────────────────────────────

export async function retroactiveGrant(
  badgeId: string,
  limit = 10000
): Promise<{ granted: number; scanned: number; error?: string }> {
  const def = await BadgeDefinition.findOne({ id: badgeId }).lean();
  if (!def) return { granted: 0, scanned: 0, error: 'Badge not found' };
  if ((def as any).conditionType === 'manual') return { granted: 0, scanned: 0, error: 'Manual badges cannot be retroactively granted' };

  // For registration_rank, use an optimized O(n) approach
  if ((def as any).conditionType === 'registration_rank') {
    return retroactiveRegistrationRank(badgeId, (def as any).conditionValue, limit);
  }

  const users = await User.find({ isDeleted: { $ne: true } })
    .select('_id badges minutesSynced wordsSynced karaokeLines currentStreak isVerified role createdAt social')
    .limit(limit)
    .lean();

  let granted = 0;
  for (const user of users) {
    if (((user as any).badges ?? []).some((b: any) => b.id === badgeId)) continue;
    const qualifies = await checkCondition(user, def);
    if (qualifies) {
      await User.updateOne(
        { _id: user._id, 'badges.id': { $ne: badgeId } },
        { $push: { badges: { id: badgeId, grantedAt: new Date(), grantedBy: 'system' } } }
      );
      notifyBadgeAwarded((user._id as any).toString(), badgeId).catch(() => {});
      recomputeXP((user._id as any).toString()).catch(() => {});
      granted++;
    }
  }

  return { granted, scanned: users.length };
}

async function retroactiveRegistrationRank(
  badgeId: string,
  rankLimit: number,
  userLimit: number
): Promise<{ granted: number; scanned: number }> {
  // Find the cutoff: the Nth user by registration date
  const cutoffUser = await User.findOne({ isDeleted: { $ne: true } })
    .sort({ createdAt: 1 })
    .skip(rankLimit - 1)
    .select('createdAt')
    .lean();

  const cutoff = cutoffUser ? (cutoffUser as any).createdAt : new Date();

  const qualifying = await User.find({
    createdAt: { $lte: cutoff },
    'badges.id': { $ne: badgeId },
    isDeleted: { $ne: true },
  }).select('_id').limit(userLimit).lean();

  for (const u of qualifying) {
    await User.updateOne(
      { _id: u._id, 'badges.id': { $ne: badgeId } },
      { $push: { badges: { id: badgeId, grantedAt: new Date(), grantedBy: 'system' } } }
    );
    notifyBadgeAwarded((u._id as any).toString(), badgeId).catch(() => {});
    recomputeXP((u._id as any).toString()).catch(() => {});
  }

  return { granted: qualifying.length, scanned: qualifying.length };
}

// ─── Stat recompute (call after lyrics/project changes) ──────────────────────

export async function recomputeSyncStats(userId: string): Promise<{
  minutesSynced: number;
  wordsSynced: number;
  karaokeLines: number;
}> {
  const userProjects = await Project.find({ userId }).select('projectId').lean();
  const projectIds = userProjects.map((p: any) => p.projectId);

  if (projectIds.length === 0) {
    await User.updateOne({ _id: userId }, { minutesSynced: 0, wordsSynced: 0, karaokeLines: 0 });
    return { minutesSynced: 0, wordsSynced: 0, karaokeLines: 0 };
  }

  const [minAgg, wordAgg, karaokeAgg] = await Promise.all([
    // Minutes: max timestamp per project, sum across projects
    Lyrics.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      {
        $project: {
          maxTs: {
            $max: {
              $map: { input: { $ifNull: ['$lines', []] }, as: 'l', in: { $ifNull: ['$$l.timestamp', 0] } },
            },
          },
        },
      },
      { $group: { _id: null, total: { $sum: '$maxTs' } } },
    ]),

    // Words synced: words with non-null time
    Lyrics.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $unwind: { path: '$lines', preserveNullAndEmptyArrays: false } },
      { $unwind: { path: '$lines.words', preserveNullAndEmptyArrays: false } },
      { $match: { 'lines.words.time': { $ne: null } } },
      { $count: 'total' },
    ]),

    // Karaoke lines: lines where ≥1 word has a time
    Lyrics.aggregate([
      { $match: { projectId: { $in: projectIds } } },
      { $unwind: { path: '$lines', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          hasKaraoke: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$lines.words', []] },
                    cond: { $ne: ['$$this.time', null] },
                  },
                },
              },
              0,
            ],
          },
        },
      },
      { $match: { hasKaraoke: true } },
      { $count: 'total' },
    ]),
  ]);

  const minutesSynced = Math.floor((minAgg[0]?.total ?? 0) / 60);
  const wordsSynced = wordAgg[0]?.total ?? 0;
  const karaokeLines = karaokeAgg[0]?.total ?? 0;

  await User.updateOne({ _id: userId }, { minutesSynced, wordsSynced, karaokeLines });
  return { minutesSynced, wordsSynced, karaokeLines };
}

// ─── Streak management ────────────────────────────────────────────────────────

export async function updateStreak(userId: string): Promise<number> {
  const user = await User.findById(userId).select('currentStreak longestStreak lastActiveDate').lean();
  if (!user) return 0;

  const todayStr = new Date().toISOString().slice(0, 10); // "2026-06-02"
  const lastDate = (user as any).lastActiveDate
    ? new Date((user as any).lastActiveDate).toISOString().slice(0, 10)
    : null;

  if (lastDate === todayStr) return (user as any).currentStreak ?? 1;

  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const current = lastDate === yesterdayStr ? ((user as any).currentStreak ?? 0) + 1 : 1;
  const longest = Math.max(current, (user as any).longestStreak ?? 0);

  await User.updateOne({ _id: userId }, {
    currentStreak: current,
    longestStreak: longest,
    lastActiveDate: new Date(),
  });

  return current;
}

// ─── XP / Level ──────────────────────────────────────────────────────────────

export function computeLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100));
}

export function getShowcaseSlots(level: number): number {
  if (level >= 100) return 8;
  if (level >= 75)  return 6;
  if (level >= 50)  return 5;
  if (level >= 25)  return 4;
  return 3;
}

// Lookup table built from BUILTIN_BADGES for O(1) xpReward resolution
const BUILTIN_XP: Map<string, number> = new Map(
  BUILTIN_BADGES.map((b) => [b.id, b.xpReward])
);

export async function recomputeXP(userId: string): Promise<number> {
  const user = await User.findById(userId)
    .select('badges minutesSynced wordsSynced social xpBonus')
    .lean();
  if (!user) return 0;

  const earnedBadgeIds: string[] = ((user as any).badges ?? []).map((b: any) => b.id);

  // Resolve xpReward per badge: builtins from lookup, custom badges from DB
  let badgeXp = 0;
  const customIds = earnedBadgeIds.filter((id) => !BUILTIN_XP.has(id));
  if (customIds.length > 0) {
    const customDefs = await BadgeDefinition.find({ id: { $in: customIds } }).select('id xpReward').lean();
    const customMap = new Map(customDefs.map((d: any) => [d.id, d.xpReward ?? 50]));
    for (const id of earnedBadgeIds) {
      badgeXp += BUILTIN_XP.get(id) ?? customMap.get(id) ?? 50;
    }
  } else {
    for (const id of earnedBadgeIds) {
      badgeXp += BUILTIN_XP.get(id) ?? 50;
    }
  }

  const mins      = (user as any).minutesSynced ?? 0;
  const words     = (user as any).wordsSynced ?? 0;
  const stars     = (user as any).social?.totalStarsReceived ?? 0;
  const forks     = (user as any).social?.totalForksReceived ?? 0;
  const followers = (user as any).social?.followerCount ?? 0;
  const bonus     = (user as any).xpBonus ?? 0;

  const xp = Math.max(0, Math.floor(
    badgeXp + mins * 2 + words * 0.1 + stars * 5 + forks * 10 + followers * 3 + bonus
  ));
  const level = computeLevel(xp);

  await User.updateOne({ _id: userId }, { xp, level });
  return xp;
}

// ─── Badge rarity (global %) ──────────────────────────────────────────────────

export async function getBadgeRarity(badgeId: string): Promise<{
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  pct: number;
  holderCount: number;
  totalUsers: number;
}> {
  const [holderCount, totalUsers] = await Promise.all([
    User.countDocuments({ 'badges.id': badgeId, isDeleted: { $ne: true } }),
    User.countDocuments({ isDeleted: { $ne: true } }),
  ]);

  const pct = totalUsers > 0 ? (holderCount / totalUsers) * 100 : 0;
  const rarity =
    pct > 50   ? 'common'    :
    pct > 10   ? 'uncommon'  :
    pct > 2    ? 'rare'      :
    pct > 0.5  ? 'epic'      :
                 'legendary';

  return { rarity, pct, holderCount, totalUsers };
}

// ─── Showcase management ──────────────────────────────────────────────────────

export async function updateShowcase(
  userId: string,
  badgeIds: string[],
  showcasePublic?: boolean
): Promise<{ success: boolean; error?: string }> {
  const user = await User.findById(userId).select('badges level showcasedBadges').lean();
  if (!user) return { success: false, error: 'User not found' };

  const level = (user as any).level ?? 0;
  const maxSlots = getShowcaseSlots(level);

  if (badgeIds.length > maxSlots) {
    return { success: false, error: `Max ${maxSlots} showcase slots at level ${level}` };
  }

  const ownedIds = new Set<string>(((user as any).badges ?? []).map((b: any) => b.id));
  const invalid = badgeIds.filter(id => !ownedIds.has(id));
  if (invalid.length > 0) {
    return { success: false, error: `Badges not owned: ${invalid.join(', ')}` };
  }

  const deduped = [...new Set(badgeIds)];
  const update: Record<string, unknown> = { showcasedBadges: deduped };
  if (showcasePublic !== undefined) update.showcasePublic = showcasePublic;
  await User.updateOne({ _id: userId }, update);
  return { success: true };
}

// ─── Notification helper ──────────────────────────────────────────────────────

async function notifyBadgeAwarded(userId: string, badgeId: string): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'badge_awarded',
    read: false,
    sticky: false,
    body: badgeId,
  });
  try {
    const io = getIO();
    io.to(`user:${userId}`).emit('notification:push', notification.toObject());
    io.to(`user:${userId}`).emit('badge:awarded', { badgeId });
  } catch { /* socket not ready */ }
}
