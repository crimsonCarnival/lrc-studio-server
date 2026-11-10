import mongoose from 'mongoose';
import User from '../users/user.model.js';
import { notifyLevelUp } from '../notifications/notifications.events.js';
import type { IUser, IUserBadge } from '../users/user.model.js';
import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Upload from '../uploads/upload.model.js';
import BadgeDefinition from './badge-definition.model.js';
import type { BadgeRarity, IBadgeDefinition } from './badge-definition.model.js';
import Notification from '../notifications/notification.model.js';
import XPEvent, { type IXPEvent } from '../progression/xp-event.model.js';
import { getIO } from '../../socket/socket.manager.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import UserPreferences from '../user-preferences/user-preferences.model.js';
import { enqueueNotif } from '../../lib/notification-heap.js';
import type { INotification } from '../notifications/notification.model.js';
import { scheduleOnce } from '../../lib/job-queue.js';
import { computeSyncStats, type SyncStats } from './sync-stats.js';
import { zonedDayKey, prevDayKey } from '../../shared/zoned-day.js';

// ─── Builtin seed data ────────────────────────────────────────────────────────

export const BUILTIN_BADGES: Array<Omit<IBadgeDefinition, 'rarity' | 'createdBy' | 'createdAt' | 'updatedAt'>> = [
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
];

// How rare each built-in badge is, set by hand from how hard it is to earn. It is a property of
// the badge, never derived from how many users hold it, so it does not drift as the user base grows.
const BUILTIN_RARITY: Record<string, BadgeRarity> = {
  og: 'legendary',
  wordsmith50k: 'legendary',
  pioneer: 'epic',
  syncer100h: 'epic',
  century: 'epic',
  karaoke1k: 'rare',
  beloved: 'rare',
  influential: 'rare',
  veteran: 'rare',
  streak30: 'rare',
  syncer10h: 'uncommon',
  wordsmith1k: 'uncommon',
  karaoke100: 'uncommon',
  published10: 'uncommon',
  following50: 'uncommon',
  uploader: 'uncommon',
  streak7: 'common',
  verified: 'common',
};

/**
 * Built-in badges that were removed from BUILTIN_BADGES. Seeding only inserts, so a retired badge
 * would otherwise live on in the database and on every holder's profile.
 * 'admin': staff are marked by the role ring instead, which is subtler than a badge.
 */
const RETIRED_BUILTIN_BADGES = ['admin'];

/**
 * Deletes retired built-in badges, takes them off their holders (badges, showcase, mini-profile
 * picks) and rebuilds those holders' XP as a 'backfill' so the drop stays off the period boards.
 * Idempotent: with nothing left to remove it is three cheap no-op queries. Returns holders changed.
 */
export async function retireBuiltinBadges(): Promise<number> {
  let holdersChanged = 0;
  for (const id of RETIRED_BUILTIN_BADGES) {
    const holders = await User.find({ 'badges.id': id }).select('_id').lean<{ _id: mongoose.Types.ObjectId }[]>();
    await BadgeDefinition.deleteOne({ id, isBuiltin: true });
    if (holders.length === 0) continue;
    await User.updateMany({ 'badges.id': id }, { $pull: { badges: { id }, showcasedBadges: id } });
    await UserPreferences.updateMany({ miniProfileBadgeIds: id }, { $pull: { miniProfileBadgeIds: id } });
    for (const h of holders) await recomputeXP(h._id.toString(), 'backfill').catch(() => 0);
    holdersChanged += holders.length;
  }
  if (holdersChanged > 0) invalidatePublicBadgeDefsCache();
  return holdersChanged;
}

// Seeds built-in badges to DB — called on server startup (plugins/cron.ts) and
// before the registration badge check. Idempotent per badge, keyed by `id`:
// missing built-ins are inserted, existing ones are left untouched ($setOnInsert
// only), so admin edits survive restarts and badges added to BUILTIN_BADGES later
// still reach existing databases. Built-ins cannot be deleted (deleteBadgeDef),
// so there is no "deliberately deleted" state to preserve.
// Note: recomputeXP reads built-in xpReward from BUILTIN_BADGES, not the DB.
export async function seedBuiltinBadges(): Promise<number> {
  const result = await BadgeDefinition.bulkWrite(
    BUILTIN_BADGES.flatMap(({ id, ...fields }) => {
      const rarity = BUILTIN_RARITY[id] ?? 'common';
      return [
        { updateOne: { filter: { id }, update: { $setOnInsert: { ...fields, rarity } }, upsert: true } },
        // Rows seeded before rarity was preset sit at the schema default. Move those onto the
        // preset; a built-in an admin already set to anything else is left alone.
        ...(rarity === 'common'
          ? []
          : [{ updateOne: { filter: { id, rarity: 'common' as const }, update: { $set: { rarity } } } }]),
      ];
    }),
    { ordered: false }
  );
  if (result.upsertedCount > 0 || result.modifiedCount > 0) invalidatePublicBadgeDefsCache();
  return result.upsertedCount;
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
  streak?: { current?: number; longest?: number; lastActiveDate?: Date | null };
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
      const n = await Project.countDocuments({ userId: user._id, public: true, listed: { $ne: false } });
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
      return getStreakView(user.streak).current >= (def.conditionValue ?? 0);
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
  grantedBy: string = 'system',
  { recompute = true }: { recompute?: boolean } = {}
): Promise<boolean> {
  // An id with no definition would still be pushed and earn the 50-XP default.
  if (!(await BadgeDefinition.exists({ id: badgeId }))) return false;
  const result = await User.findOneAndUpdate(
    { _id: userId, 'badges.id': { $ne: badgeId } },
    { $push: { badges: { id: badgeId, grantedAt: new Date(), grantedBy } } },
    { returnDocument: 'after' }
  );
  if (!result) return false; // already had it or user not found

  notifyBadgeAwarded(userId, badgeId).catch(() => {});
  // triggerBadgeCheck grants several badges in a loop and recomputes once afterwards, so the
  // concurrent read-compute-write recomputes cannot overwrite one another.
  if (recompute) recomputeXP(userId).catch(() => {});
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

// ─── Badge definition CRUD (shared by GraphQL resolvers + request executor) ──

export interface BadgeDefInput {
  id?: string;
  label?: { en: string; es?: string };
  description?: { en: string; es?: string };
  icon?: string;
  color?: string;
  rarity?: string;
  conditionType?: string;
  conditionValue?: number | null;
  autoGrant?: boolean;
  xpReward?: number;
}

export type BadgeDefWithHolders = IBadgeDefinition & { holderCount: number; holderPct: number };

/** All badge definitions with holder counts. Admin view — includes condition/XP internals. */
export async function listBadgeDefsWithHolders(): Promise<BadgeDefWithHolders[]> {
  const [defs, totalUsers, holderCounts] = await Promise.all([
    BadgeDefinition.find().lean<IBadgeDefinition[]>(),
    User.countDocuments({ isDeleted: { $ne: true } }),
    User.aggregate<{ _id: string; count: number }>([
      { $unwind: '$badges' },
      { $group: { _id: '$badges.id', count: { $sum: 1 } } },
    ]),
  ]);
  const hcMap = new Map<string, number>(holderCounts.map(r => [r._id, r.count]));
  return defs.map(d => {
    const holderCount = hcMap.get(d.id) ?? 0;
    const holderPct = totalUsers > 0 ? parseFloat(((holderCount / totalUsers) * 100).toFixed(1)) : 0;
    return { ...d, holderCount, holderPct };
  });
}

/** Display-only projection, safe for any viewer (including guests). */
export type PublicBadgeDef = Pick<IBadgeDefinition, 'id' | 'label' | 'description' | 'icon' | 'color' | 'rarity'> & {
  holderCount: number;
  holderPct: number;
};

// The holder-count aggregation unwinds every user's badges; the public query is
// unauthenticated and hit on every app load, so cache it briefly.
const PUBLIC_DEFS_TTL_MS = 60_000;
let publicDefsCache: { at: number; defs: PublicBadgeDef[] } | null = null;

export function invalidatePublicBadgeDefsCache(): void {
  publicDefsCache = null;
}

export async function listPublicBadgeDefs(): Promise<PublicBadgeDef[]> {
  if (publicDefsCache && Date.now() - publicDefsCache.at < PUBLIC_DEFS_TTL_MS) return publicDefsCache.defs;
  const defs = (await listBadgeDefsWithHolders()).map(d => ({
    id: d.id,
    label: d.label,
    description: d.description,
    icon: d.icon,
    color: d.color,
    rarity: d.rarity ?? 'common',
    holderCount: d.holderCount,
    holderPct: d.holderPct,
  }));
  publicDefsCache = { at: Date.now(), defs };
  return defs;
}

/**
 * Upper bound for a custom badge's XP reward. Built-ins top out at 1,500; 10,000 is an assumption
 * that leaves room for event badges while stopping a definition from minting levels on its own.
 */
export const MAX_BADGE_XP_REWARD = 10_000;

function assertValidXpReward(xpReward: number | undefined): void {
  if (xpReward === undefined) return;
  if (!Number.isInteger(xpReward) || xpReward < 0 || xpReward > MAX_BADGE_XP_REWARD) {
    throw Object.assign(new Error(`xpReward must be an integer between 0 and ${MAX_BADGE_XP_REWARD}`), { status: 400 });
  }
}

export async function createBadgeDef(input: BadgeDefInput, createdBy?: string): Promise<Record<string, unknown>> {
  assertValidXpReward(input.xpReward);
  const def = await BadgeDefinition.create({ ...input, isBuiltin: false, createdBy } as unknown as IBadgeDefinition);
  invalidatePublicBadgeDefsCache();
  return { ...def.toObject(), holderCount: 0, holderPct: 0 };
}

export async function updateBadgeDef(id: string, input: BadgeDefInput): Promise<Record<string, unknown>> {
  assertValidXpReward(input.xpReward);
  const def = await BadgeDefinition.findOneAndUpdate({ id }, { $set: input }, { returnDocument: 'after' });
  if (!def) throw new Error('Badge not found');
  invalidatePublicBadgeDefsCache();
  const [holderCount, totalUsers] = await Promise.all([
    User.countDocuments({ 'badges.id': id, isDeleted: { $ne: true } }),
    User.countDocuments({ isDeleted: { $ne: true } }),
  ]);
  const holderPct = totalUsers > 0 ? parseFloat(((holderCount / totalUsers) * 100).toFixed(1)) : 0;
  return { ...def.toObject(), holderCount, holderPct };
}

export async function deleteBadgeDef(id: string): Promise<boolean> {
  const def = await BadgeDefinition.findOne({ id }).lean<IBadgeDefinition>();
  if (!def) throw new Error('Badge not found');
  if (def.isBuiltin) throw new Error('Cannot delete built-in badges');
  await BadgeDefinition.deleteOne({ id });
  invalidatePublicBadgeDefsCache();
  return true;
}

// ─── Badge trigger (called after events) ─────────────────────────────────────

export async function triggerBadgeCheck(userId: string, event: BadgeEvent): Promise<string[]> {
  const relevantConditions = EVENT_CONDITIONS[event] ?? [];
  if (relevantConditions.length === 0) return [];

  const [user, defs] = await Promise.all([
    User.findById(userId).lean<IUser>(),
    BadgeDefinition.find({ autoGrant: true, conditionType: { $in: relevantConditions as IBadgeDefinition['conditionType'][] } }).lean<IBadgeDefinition[]>(),
  ]);
  if (!user) return [];

  const existingIds = new Set<string>((user.badges ?? []).map((b: IUserBadge) => b.id));
  const granted: string[] = [];

  for (const def of defs) {
    if (existingIds.has(def.id)) continue;
    const qualifies = await checkCondition(user as unknown as UserForCondition, def);
    if (qualifies) {
      const ok = await grantBadge(userId, def.id, 'system', { recompute: false });
      if (ok) granted.push(def.id);
    }
  }

  if (granted.length > 0) await recomputeXP(userId).catch(() => 0);
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

export async function recomputeSyncStats(userId: string): Promise<SyncStats> {
  const userProjects = await Project.find({ userId }).select('publicId').lean<{ publicId: string }[]>();
  const publicIds: string[] = userProjects.map((p) => p.publicId);

  // At most MAX_PROJECTS_PER_USER (200) documents; a pure reducer over them replaces six pipelines.
  const docs = publicIds.length === 0
    ? []
    : await Lyrics.find({ publicId: { $in: publicIds } }).select('sections +lines').lean();
  const stats = computeSyncStats(docs as Parameters<typeof computeSyncStats>[0]);

  await User.updateOne({ _id: userId }, { $set: {
    'stats.minutesSynced': stats.minutesSynced,
    'stats.secondsSynced': stats.secondsSynced,
    'stats.wordsSynced': stats.wordsSynced,
    'stats.karaokeLines': stats.karaokeLines,
    'stats.syncedLines': stats.syncedLines,
    'stats.aiSyncedLines': stats.aiSyncedLines,
    'stats.aiWordsSynced': stats.aiWordsSynced,
    statsComputedAt: new Date(),
  } });
  return stats;
}

// ─── Coalesced stat refresh (call from save paths) ───────────────────────────

// recomputeSyncStats walks every line and word of every project the user owns,
// and autosave fires every few edits — so saves only queue a job and one
// recompute covers the whole burst. A pending job is not rescheduled by later
// saves, so a refresh always lands within the window and after the last save
// in it. The job lives in the Mongo-backed queue: it survives a restart and
// runs once no matter how many instances saw the saves.
export const SYNC_STATS_REFRESH_JOB = 'sync-stats-refresh';
const SYNC_STATS_REFRESH_DELAY = 'in 60 seconds';

export function scheduleSyncStatsRefresh(userId: string): void {
  // Fire-and-forget, like every other post-save side effect. If the queue is
  // down the refresh is skipped; getProject's staleness check recovers it on
  // the next load.
  scheduleOnce(SYNC_STATS_REFRESH_JOB, userId, { userId }, SYNC_STATS_REFRESH_DELAY).catch(() => {});
}

export async function runSyncStatsRefresh({ userId }: { userId: string }): Promise<void> {
  await recomputeSyncStats(userId);
  await triggerBadgeCheck(userId, 'sync_update');
  // XP is derived from stats, so it has to follow them; before this it only moved on a badge change.
  await recomputeXP(userId);
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

/** Minimum real time between two counted days when the timezone changed in between. */
const MIN_HOPPED_DAY_GAP_MS = 20 * 60 * 60 * 1000;

export async function updateStreak(userId: string, now: Date = new Date()): Promise<number> {
  const user = await User.findById(userId).select('streak').lean<LeanUserStreak>();
  if (!user) return 0;

  // Days are the user's own calendar days (streak.timezone), not UTC ones.
  const tz = user.streak?.timezone;
  const todayStr = zonedDayKey(now, tz);
  const lastDate = user.streak?.lastActiveDate ? zonedDayKey(new Date(user.streak.lastActiveDate), tz) : null;

  if (lastDate === todayStr) return user.streak?.current ?? 1;

  // A timezone change since the last activity can make "today" a new day with no real day passing.
  // Count a new day only once enough real time has elapsed, so zone hopping cannot add streak days.
  const lastAt = user.streak?.lastActiveDate ? new Date(user.streak.lastActiveDate).getTime() : null;
  const tzChangedAt = user.streak?.timezoneChangedAt ? new Date(user.streak.timezoneChangedAt).getTime() : null;
  if (lastAt !== null && tzChangedAt !== null && tzChangedAt > lastAt && now.getTime() - lastAt < MIN_HOPPED_DAY_GAP_MS) {
    return user.streak?.current ?? 1;
  }

  const current = lastDate === prevDayKey(todayStr) ? (user.streak?.current ?? 0) + 1 : 1;
  const longest = Math.max(current, user.streak?.longest ?? 0);

  await User.updateOne({ _id: userId }, {
    'streak.current': current,
    'streak.longest': longest,
    'streak.lastActiveDate': now,
  });

  return current;
}

export type StreakView = { current: number; longest: number; lastActiveDate: string | null };

/**
 * Read-side view of a stored streak. `streak.current` is only rewritten when the
 * user is active again, so a streak broken days ago still holds its old value in
 * the DB. A streak is alive only if the last active day (in the user's own timezone,
 * `streak.timezone`, UTC when unset) is today or yesterday; otherwise the effective
 * current streak is 0.
 */
export function getStreakView(
  streak: { current?: number; longest?: number; lastActiveDate?: Date | string | null; timezone?: string | null } | null | undefined,
  now: Date = new Date()
): StreakView {
  const last = streak?.lastActiveDate ? new Date(streak.lastActiveDate) : null;
  const lastValid = last && !Number.isNaN(last.getTime()) ? last : null;
  const tz = streak?.timezone;
  const lastDay = lastValid ? zonedDayKey(lastValid, tz) : null;
  const today = zonedDayKey(now, tz);
  const alive = lastDay === today || lastDay === prevDayKey(today);
  return {
    current: alive ? (streak?.current ?? 0) : 0,
    longest: streak?.longest ?? 0,
    lastActiveDate: lastValid ? lastValid.toISOString() : null,
  };
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

/**
 * Inverse of `computeLevel`: the minimum XP total that reaches `level`.
 *
 * Single source of truth for the level curve — the admin dashboard reads it
 * through the `xpLevelCurve` query rather than hardcoding `level² × 100`, so
 * changing `computeLevel` here cannot silently desync the UI.
 */
export function xpRequiredForLevel(level: number): number {
  const l = Math.max(0, Math.floor(level));
  return l * l * 100;
}

export function computeXPFromStats(
  badgeXp: number,
  stats: { minutesSynced?: number; secondsSynced?: number; wordsSynced?: number; karaokeLines?: number },
  social?: { totalStarsReceived?: number; totalForksReceived?: number; followerCount?: number },
  // Manual admin adjustments. Folded into the derived total so that
  // recomputeXP, which overwrites progression.xp, does not erase them.
  bonusXp = 0
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

  return Math.max(0, Math.floor(badgeXp + craftXp + communityXp + bonusXp));
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

/**
 * Rebuilds `progression.xp` from badges, stats, social counts and the admin bonus.
 * `eventType` 'backfill' is for one-off corrections: those deltas are kept off the weekly and
 * monthly XP boards, which would otherwise credit months of old work to the week it was applied.
 */
export async function recomputeXP(userId: string, eventType: 'recompute' | 'backfill' = 'recompute'): Promise<number> {
  const user = await User.findById(userId)
    .select('badges stats social progression')
    .lean<LeanUserXP & { progression?: { xp?: number; bonusXp?: number; level?: number } }>();
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

  // bonusXp carries manual admin grants/revokes. Without it this overwrite
  // would discard every admin XP adjustment the next time a badge changed.
  const newXp = computeXPFromStats(badgeXp, user.stats ?? {}, user.social, user.progression?.bonusXp ?? 0);
  const newLevel = computeLevel(newXp);
  const oldXp = user.progression?.xp ?? 0;
  const delta = newXp - oldXp;

  await User.updateOne({ _id: userId }, { 'progression.xp': newXp, 'progression.level': newLevel, 'progression.lastXpEventAt': new Date() });
  if (newLevel > (user.progression?.level ?? 0)) notifyLevelUp(userId, newLevel).catch(() => {});

  // Log event if XP changed (indicates badge grant/revoke or stats update triggered this)
  if (delta !== 0) {
    await XPEvent.create({
      userId: new mongoose.Types.ObjectId(userId),
      type: eventType,
      source: 'system',
      delta,
      totalXpAfter: newXp,
      reason: eventType === 'backfill' ? 'backfill' : 'badge, stat or social update',
      createdAt: new Date(),
    });
  }

  return newXp;
}

// ─── Badge rarity ─────────────────────────────────────────────────────────────

// Rarity is the definition's own preset; the holder count is shown beside it as a popularity
// figure and never feeds back into it.
export async function getBadgeRarity(badgeId: string): Promise<{
  rarity: BadgeRarity;
  holderCount: number;
}> {
  const [def, holderCount] = await Promise.all([
    BadgeDefinition.findOne({ id: badgeId }).select('rarity').lean<IBadgeDefinition>(),
    User.countDocuments({ 'badges.id': badgeId, isDeleted: { $ne: true } }),
  ]);
  return { rarity: def?.rarity ?? 'common', holderCount };
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
  const prefs = await getPreferences(userId);
  if (!prefs.notifications.badge_awarded) return;

  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'badge_awarded',
    read: false,
    sticky: false,
    body: badgeId,
  });
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
  try {
    const io = getIO();
    io.to(`user:${userId}`).emit('notification:push', notification.toObject());
    io.to(`user:${userId}`).emit('badge:awarded', { badgeId });
  } catch { /* socket not ready */ }
}
