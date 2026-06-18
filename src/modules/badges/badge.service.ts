import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import type { IUser, IUserBadge } from '../../db/user.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import BadgeDefinition from './badge-definition.model.js';
import type { IBadgeDefinition } from './badge-definition.model.js';
import Notification from '../notifications/notification.model.js';
import XPEvent, { type IXPEvent } from '../progression/xp-event.model.js';
import { getIO } from '../../socket/socket.manager.js';

// ─── Builtin seed data ────────────────────────────────────────────────────────

export const BUILTIN_BADGES = [
  { id: 'og',          label: { en: 'Side A', es: 'OG' },         description: { en: 'One of the first 100 users to join', es: 'Uno de los primeros 100 usuarios en unirse' },       icon: '🏆', color: 'amber',   conditionType: 'registration_rank',    conditionValue: 100,   autoGrant: true, isBuiltin: true, xpReward: 750 },
  { id: 'pioneer',     label: { en: 'Pioneer', es: 'Pionero' },          description: { en: 'Among the first 1,000 users', es: 'Entre los primeros 1.000 usuarios' },              icon: '🚀', color: 'teal',    conditionType: 'registration_rank',    conditionValue: 1000,  autoGrant: true, isBuiltin: true, xpReward: 200 },
  { id: 'syncer10h',   label: { en: 'Open Mic', es: 'Sincronizado 10h' },       description: { en: 'Synced at least 10 hours of lyrics', es: '10 horas de letras sincronizadas' },       icon: '🎵', color: 'green',   conditionType: 'minutes_synced',       conditionValue: 600,   autoGrant: true, isBuiltin: true, xpReward: 200 },
  { id: 'syncer100h',  label: { en: 'World Tour', es: 'Sincronizado 100h' },     description: { en: 'Synced at least 100 hours of lyrics', es: '100 horas de letras sincronizadas' },      icon: '🎶', color: 'green',   conditionType: 'minutes_synced',       conditionValue: 6000,  autoGrant: true, isBuiltin: true, xpReward: 1000 },
  { id: 'wordsmith1k', label: { en: 'Verse One', es: 'Artesano' },      description: { en: 'Timestamped 1,000 individual words', es: '1.000 palabras con marca de tiempo' },       icon: '✍️', color: 'blue',    conditionType: 'words_synced',         conditionValue: 1000,  autoGrant: true, isBuiltin: true, xpReward: 300 },
  { id: 'wordsmith50k',label: { en: 'Grand Opus', es: 'Maestro lírico' },     description: { en: 'Timestamped 50,000 individual words', es: '50.000 palabras con marca de tiempo' },      icon: '📖', color: 'shimmer', conditionType: 'words_synced',         conditionValue: 50000, autoGrant: true, isBuiltin: true, xpReward: 1500 },
  { id: 'karaoke100',  label: { en: 'On Stage', es: 'Héroe del karaoke' },       description: { en: 'Word-synced 100 lyric lines', es: '100 líneas con tiempo a nivel de palabra' },              icon: '🎤', color: 'orange',  conditionType: 'karaoke_lines',        conditionValue: 100,   autoGrant: true, isBuiltin: true, xpReward: 250 },
  { id: 'karaoke1k',   label: { en: 'Headliner', es: 'Estrella' },      description: { en: 'Word-synced 1,000 lyric lines', es: '1.000 líneas con tiempo a nivel de palabra' },            icon: '🌟', color: 'amber',   conditionType: 'karaoke_lines',        conditionValue: 1000,  autoGrant: true, isBuiltin: true, xpReward: 800 },
  { id: 'century',     label: { en: 'Anthology', es: 'Centenario' },      description: { en: 'Created 100+ projects', es: '100 proyectos creados' },                    icon: '💫', color: 'shimmer', conditionType: 'project_count',        conditionValue: 100,   autoGrant: true, isBuiltin: true, xpReward: 600 },
  { id: 'published10', label: { en: 'In Rotation', es: 'Publicador' },    description: { en: 'Published 10 public projects', es: '10 proyectos públicos publicados' },             icon: '📢', color: 'teal',    conditionType: 'public_project_count', conditionValue: 10,    autoGrant: true, isBuiltin: true, xpReward: 150 },
  { id: 'beloved',     label: { en: 'Gold Record', es: 'Amado' },    description: { en: 'Received 50 stars on your work', es: '50 estrellas recibidas en tu trabajo' },           icon: '⭐', color: 'amber',   conditionType: 'stars_received',       conditionValue: 50,    autoGrant: true, isBuiltin: true, xpReward: 250 },
  { id: 'influential', label: { en: 'Sampled', es: 'Influyente' },        description: { en: 'Your work has been forked 25 times', es: 'Tu trabajo ha sido bifurcado 25 veces' },       icon: '🌿', color: 'green',   conditionType: 'forks_received',       conditionValue: 25,    autoGrant: true, isBuiltin: true, xpReward: 200 },
  { id: 'following50', label: { en: 'Fan Base', es: 'Bien conectado' },       description: { en: 'Reached 50 followers', es: '50 seguidores' },                     icon: '🤝', color: 'primary', conditionType: 'follower_count',       conditionValue: 50,    autoGrant: true, isBuiltin: true, xpReward: 100 },
  { id: 'uploader',    label: { en: 'Studio Ready', es: 'Subidor' },   description: { en: 'Uploaded 10 media files', es: '10 archivos multimedia subidos' },                  icon: '📤', color: 'blue',    conditionType: 'upload_count',         conditionValue: 10,    autoGrant: true, isBuiltin: true, xpReward: 150 },
  { id: 'veteran',     label: { en: 'Session Player', es: 'Veterano' }, description: { en: 'Account is at least 1 year old', es: 'Cuenta con al menos 1 año de antigüedad' },           icon: '🎖️', color: 'rose',   conditionType: 'account_age_days',     conditionValue: 365,   autoGrant: true, isBuiltin: true, xpReward: 300 },
  { id: 'streak7',     label: { en: 'Daily Mix', es: 'En racha' },      description: { en: '7-day activity streak', es: 'Racha de actividad de 7 días' },                    icon: '🔥', color: 'orange',  conditionType: 'streak_days',          conditionValue: 7,     autoGrant: true, isBuiltin: true, xpReward: 100 },
  { id: 'streak30',    label: { en: 'Extended Play', es: 'Imparable' },  description: { en: '30-day activity streak', es: 'Racha de actividad de 30 días' },                   icon: '⚡', color: 'amber',   conditionType: 'streak_days',          conditionValue: 30,    autoGrant: true, isBuiltin: true, xpReward: 300 },
  { id: 'verified',    label: { en: 'In Key', es: 'Verificado' },         description: { en: 'Verified email address', es: 'Correo electrónico verificado' },                   icon: '✓',  color: 'primary', conditionType: 'is_verified',          conditionValue: null,  autoGrant: true, isBuiltin: true, xpReward: 50  },
  { id: 'admin',       label: { en: 'A&R', es: 'Staff' },            description: { en: 'Platform administrator', es: 'Miembro del equipo de LRC Studio' },                   icon: '🛡️', color: 'rose',   conditionType: 'role_admin',           conditionValue: null,  autoGrant: true, isBuiltin: true, xpReward: 500 },
];

// Seeds built-in badges to DB — called on server startup.
// $setOnInsert: display fields (label, description, icon, color) so admin edits survive redeployment.
// $set: xpReward only — always synced from code so balance changes deploy immediately.
// Additionally, we merge Spanish localization strings into existing records during this transition.
export async function seedBuiltinBadges(): Promise<void> {
  for (const { id, label, description, icon, color, conditionType, conditionValue, autoGrant, isBuiltin, xpReward } of BUILTIN_BADGES) {
    await BadgeDefinition.findOneAndUpdate(
      { id },
      {
        $setOnInsert: { icon, color, conditionType, conditionValue, autoGrant, isBuiltin },
        $set: { xpReward, label, description },
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

type UserForCondition = {
  _id: mongoose.Types.ObjectId;
  createdAt?: Date;
  stats?: { minutesSynced?: number; secondsSynced?: number; wordsSynced?: number; karaokeLines?: number };
  streak?: { current?: number };
  isVerified: boolean;
  role: 'user' | 'admin';
  social?: { totalStarsReceived?: number; totalForksReceived?: number; followerCount?: number };
};

export async function checkCondition(user: UserForCondition, def: IBadgeDefinition): Promise<boolean> {
  switch (def.conditionType) {
    case 'registration_rank': {
      const rank = await User.countDocuments({ createdAt: { $lte: user.createdAt } });
      return rank <= (def.conditionValue ?? 0);
    }
    case 'minutes_synced':
      return (user.stats?.minutesSynced ?? 0) >= (def.conditionValue ?? 0);
    case 'words_synced':
      return (user.stats?.wordsSynced ?? 0) >= (def.conditionValue ?? 0);
    case 'karaoke_lines':
      return (user.stats?.karaokeLines ?? 0) >= (def.conditionValue ?? 0);
    case 'project_count': {
      const n = await Project.countDocuments({ userId: user._id });
      return n >= (def.conditionValue ?? 0);
    }
    case 'public_project_count': {
      const n = await Project.countDocuments({ userId: user._id, public: true });
      return n >= (def.conditionValue ?? 0);
    }
    case 'stars_received':
      return (user.social?.totalStarsReceived ?? 0) >= (def.conditionValue ?? 0);
    case 'forks_received':
      return (user.social?.totalForksReceived ?? 0) >= (def.conditionValue ?? 0);
    case 'follower_count':
      return (user.social?.followerCount ?? 0) >= (def.conditionValue ?? 0);
    case 'upload_count': {
      const n = await Upload.countDocuments({ userId: user._id });
      return n >= (def.conditionValue ?? 0);
    }
    case 'account_age_days': {
      const days = (Date.now() - new Date(user.createdAt!).getTime()) / 86400000;
      return days >= (def.conditionValue ?? 0);
    }
    case 'streak_days':
      return (user.streak?.current ?? 0) >= (def.conditionValue ?? 0);
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
    User.findById(userId).lean<IUser>(),
    BadgeDefinition.find({ autoGrant: true, conditionType: { $in: relevantConditions } }).lean<IBadgeDefinition[]>(),
  ]);
  if (!user) return [];

  const existingIds = new Set<string>((user.badges ?? []).map((b: IUserBadge) => b.id));
  const granted: string[] = [];

  for (const def of defs) {
    if (existingIds.has(def.id)) continue;
    const qualifies = await checkCondition(user as unknown as UserForCondition, def);
    if (qualifies) {
      const ok = await grantBadge(userId, def.id, 'system');
      if (ok) granted.push(def.id);
    }
  }

  return granted;
}

// ─── Retroactive scan ─────────────────────────────────────────────────────────

export async function retroactiveGrant(
  badgeId: string,
  limit = 10000
): Promise<{ granted: number; scanned: number; error?: string }> {
  const def = await BadgeDefinition.findOne({ id: badgeId }).lean<IBadgeDefinition>();
  if (!def) return { granted: 0, scanned: 0, error: 'Badge not found' };
  if (def.conditionType === 'manual') return { granted: 0, scanned: 0, error: 'Manual badges cannot be retroactively granted' };

  // For registration_rank, use an optimized O(n) approach
  if (def.conditionType === 'registration_rank') {
    return retroactiveRegistrationRank(badgeId, def.conditionValue ?? 0, limit);
  }

  const users = await User.find({ isDeleted: { $ne: true } })
    .select('_id badges stats streak isVerified role createdAt social')
    .limit(limit)
    .lean<IUser[]>();

  let granted = 0;
  for (const user of users) {
    if ((user.badges ?? []).some((b: IUserBadge) => b.id === badgeId)) continue;
    const qualifies = await checkCondition(user as unknown as UserForCondition, def);
    if (qualifies) {
      await User.updateOne(
        { _id: user._id, 'badges.id': { $ne: badgeId } },
        { $push: { badges: { id: badgeId, grantedAt: new Date(), grantedBy: 'system' } } }
      );
      notifyBadgeAwarded(user._id.toString(), badgeId).catch(() => {});
      recomputeXP(user._id.toString()).catch(() => {});
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
    .lean<IUser>();

  const cutoff = cutoffUser ? cutoffUser.createdAt : new Date();

  const qualifying = await User.find({
    createdAt: { $lte: cutoff },
    'badges.id': { $ne: badgeId },
    isDeleted: { $ne: true },
  }).select('_id').limit(userLimit).lean<IUser[]>();

  for (const u of qualifying) {
    await User.updateOne(
      { _id: u._id, 'badges.id': { $ne: badgeId } },
      { $push: { badges: { id: badgeId, grantedAt: new Date(), grantedBy: 'system' } } }
    );
    notifyBadgeAwarded(u._id.toString(), badgeId).catch(() => {});
    recomputeXP(u._id.toString()).catch(() => {});
  }

  return { granted: qualifying.length, scanned: qualifying.length };
}

// ─── Stat recompute (call after lyrics/project changes) ──────────────────────

export async function recomputeSyncStats(userId: string): Promise<{
  minutesSynced: number;
  secondsSynced: number;
  wordsSynced: number;
  karaokeLines: number;
}> {
  const userProjects = await Project.find({ userId }).select('publicId').lean<{ publicId: string }[]>();
  const publicIds: string[] = userProjects.map((p) => p.publicId);

  if (publicIds.length === 0) {
    await User.updateOne({ _id: userId }, { 'stats.minutesSynced': 0, 'stats.secondsSynced': 0, 'stats.wordsSynced': 0, 'stats.karaokeLines': 0 });
    return { minutesSynced: 0, secondsSynced: 0, wordsSynced: 0, karaokeLines: 0 };
  }

  const [minAgg, wordAgg, karaokeAgg] = await Promise.all([
    // Minutes: max timestamp per project (across all sections' lines), sum across projects
    Lyrics.aggregate([
      { $match: { publicId: { $in: publicIds } } },
      {
        $project: {
          allTimestamps: {
            $reduce: {
              input: { $ifNull: ['$sections', []] },
              initialValue: [],
              in: {
                $concatArrays: [
                  '$$value',
                  { $map: { input: { $ifNull: ['$$this.lines', []] }, as: 'l', in: { $ifNull: ['$$l.timestamp', 0] } } },
                ],
              },
            },
          },
        },
      },
      { $project: { maxTs: { $max: '$allTimestamps' } } },
      { $group: { _id: null, total: { $sum: '$maxTs' } } },
    ]),

    // Words synced: words with non-null time
    Lyrics.aggregate([
      { $match: { publicId: { $in: publicIds } } },
      { $unwind: { path: '$sections', preserveNullAndEmptyArrays: false } },
      { $unwind: { path: '$sections.lines', preserveNullAndEmptyArrays: false } },
      { $unwind: { path: '$sections.lines.words', preserveNullAndEmptyArrays: false } },
      { $match: { 'sections.lines.words.time': { $ne: null } } },
      { $count: 'total' },
    ]),

    // Karaoke lines: lines where ≥1 word has a time
    Lyrics.aggregate([
      { $match: { publicId: { $in: publicIds } } },
      { $unwind: { path: '$sections', preserveNullAndEmptyArrays: false } },
      { $unwind: { path: '$sections.lines', preserveNullAndEmptyArrays: false } },
      {
        $project: {
          hasKaraoke: {
            $gt: [
              {
                $size: {
                  $filter: {
                    input: { $ifNull: ['$sections.lines.words', []] },
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

  const totalSeconds = minAgg[0]?.total ?? 0;
  const minutesSynced = Math.floor(totalSeconds / 60);
  const secondsSynced = Math.floor(totalSeconds % 60);
  const wordsSynced = wordAgg[0]?.total ?? 0;
  const karaokeLines = karaokeAgg[0]?.total ?? 0;

  await User.updateOne({ _id: userId }, { 'stats.minutesSynced': minutesSynced, 'stats.secondsSynced': secondsSynced, 'stats.wordsSynced': wordsSynced, 'stats.karaokeLines': karaokeLines });
  return { minutesSynced, secondsSynced, wordsSynced, karaokeLines };
}

// ─── XP Event logging (event-based system) ────────────────────────────────────

export async function logXPEvent(
  userId: string,
  type: 'badge_grant' | 'badge_revoke' | 'admin_adjustment' | 'backfill',
  source: string,
  delta: number,
  reason?: string
): Promise<number> {
  const user = await User.findById(userId).select('progression').lean<{ progression?: { xp?: number } }>();
  if (!user) return 0;

  const newTotalXp = Math.max(0, (user.progression?.xp ?? 0) + delta);
  const newLevel = computeLevel(newTotalXp);

  await Promise.all([
    User.updateOne({ _id: userId }, {
      'progression.xp': newTotalXp,
      'progression.level': newLevel,
      'progression.lastXpEventAt': new Date(),
    }),
    XPEvent.create({
      userId: new mongoose.Types.ObjectId(userId),
      type,
      source,
      delta,
      totalXpAfter: newTotalXp,
      reason,
      createdAt: new Date(),
    }),
  ]);

  return newTotalXp;
}

export async function getXPHistory(userId: string, limit = 50): Promise<IXPEvent[]> {
  return XPEvent.find({ userId: new mongoose.Types.ObjectId(userId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<IXPEvent[]>();
}

export async function validateXPIntegrity(userId: string): Promise<{
  valid: boolean;
  storedXp: number;
  calculatedXp: number;
  mismatch?: number;
}> {
  const user = await User.findById(userId).select('progression').lean<{ progression?: { xp?: number } }>();
  if (!user) return { valid: false, storedXp: 0, calculatedXp: 0 };

  const events = await XPEvent.find({ userId: new mongoose.Types.ObjectId(userId) })
    .sort({ createdAt: 1 })
    .lean<IXPEvent[]>();

  const calculated = events.length > 0 ? events[events.length - 1].totalXpAfter : 0;
  const stored = user.progression?.xp ?? 0;

  return {
    valid: stored === calculated,
    storedXp: stored,
    calculatedXp: calculated,
    mismatch: stored !== calculated ? stored - calculated : undefined,
  };
}

// ─── Streak management ────────────────────────────────────────────────────────

type LeanUserStreak = Pick<IUser, 'streak'>;

export async function updateStreak(userId: string): Promise<number> {
  const user = await User.findById(userId).select('streak').lean<LeanUserStreak>();
  if (!user) return 0;

  const todayStr = new Date().toISOString().slice(0, 10); // "2026-06-02"
  const lastDate = user.streak?.lastActiveDate
    ? new Date(user.streak.lastActiveDate).toISOString().slice(0, 10)
    : null;

  if (lastDate === todayStr) return user.streak?.current ?? 1;

  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const current = lastDate === yesterdayStr ? (user.streak?.current ?? 0) + 1 : 1;
  const longest = Math.max(current, user.streak?.longest ?? 0);

  await User.updateOne({ _id: userId }, {
    'streak.current': current,
    'streak.longest': longest,
    'streak.lastActiveDate': new Date(),
  });

  return current;
}

// ─── XP / Level ──────────────────────────────────────────────────────────────

// Coefficients: craft-focused economy, followers less inflated
const XP_COEFFICIENTS = {
  minutesSynced: 3,        // 1h music = 180 XP
  wordsSynced: 0.25,       // 1000 words = 250 XP
  karaokeLines: 0.5,       // 100 lines = 50 XP
  starsReceived: 3,        // 10 stars = 30 XP
  forksReceived: 5,        // 10 forks = 50 XP
  followerCount: 1.5,      // 100 followers = 150 XP (reduced from 3)
};

export function computeLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100));
}

export function computeXPFromStats(
  badgeXp: number,
  stats: { minutesSynced?: number; secondsSynced?: number; wordsSynced?: number; karaokeLines?: number },
  social?: { totalStarsReceived?: number; totalForksReceived?: number; followerCount?: number }
): number {
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

type LeanUserXP = Pick<IUser, 'badges' | 'stats' | 'social'>;

export async function recomputeXP(userId: string): Promise<number> {
  const user = await User.findById(userId)
    .select('badges stats social progression')
    .lean<LeanUserXP & { progression?: { xp?: number } }>();
  if (!user) return 0;

  const earnedBadgeIds: string[] = (user.badges ?? []).map((b: IUserBadge) => b.id);

  // Resolve xpReward per badge: builtins from lookup, custom badges from DB
  let badgeXp = 0;
  const customIds = earnedBadgeIds.filter((id) => !BUILTIN_XP.has(id));
  if (customIds.length > 0) {
    const customDefs = await BadgeDefinition.find({ id: { $in: customIds } }).select('id xpReward').lean<Pick<IBadgeDefinition, 'id' | 'xpReward'>[]>();
    const customMap = new Map<string, number>(customDefs.map((d) => [d.id, d.xpReward ?? 50]));
    for (const id of earnedBadgeIds) {
      badgeXp += BUILTIN_XP.get(id) ?? customMap.get(id) ?? 50;
    }
  } else {
    for (const id of earnedBadgeIds) {
      badgeXp += BUILTIN_XP.get(id) ?? 50;
    }
  }

  const newXp = computeXPFromStats(badgeXp, user.stats ?? {}, user.social);
  const newLevel = computeLevel(newXp);
  const oldXp = user.progression?.xp ?? 0;
  const delta = newXp - oldXp;

  await User.updateOne({ _id: userId }, { 'progression.xp': newXp, 'progression.level': newLevel, 'progression.lastXpEventAt': new Date() });

  // Log event if XP changed (indicates badge grant/revoke or stats update triggered this)
  if (delta !== 0) {
    await XPEvent.create({
      userId: new mongoose.Types.ObjectId(userId),
      type: 'badge_grant',
      source: 'system',
      delta,
      totalXpAfter: newXp,
      reason: 'badge or stat update',
      createdAt: new Date(),
    });
  }

  return newXp;
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

type LeanUserShowcase = Pick<IUser, 'badges' | 'progression' | 'showcasedBadges'>;

export async function updateShowcase(
  userId: string,
  badgeIds: string[],
  showcasePublic?: boolean
): Promise<{ success: boolean; error?: string }> {
  const user = await User.findById(userId).select('badges progression showcasedBadges').lean<LeanUserShowcase>();
  if (!user) return { success: false, error: 'User not found' };

  const level = user.progression?.level ?? 0;
  const maxSlots = getShowcaseSlots(level);

  if (badgeIds.length > maxSlots) {
    return { success: false, error: `Max ${maxSlots} showcase slots at level ${level}` };
  }

  const ownedIds = new Set<string>((user.badges ?? []).map((b: IUserBadge) => b.id));
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
