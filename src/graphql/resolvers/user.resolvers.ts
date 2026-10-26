import mercurius from 'mercurius';
import mongoose from 'mongoose';
import User from '../../modules/users/user.model.js';
import type { IUser, IUserBadge, IUserStats } from '../../modules/users/user.model.js';
import XPEvent from '../../modules/progression/xp-event.model.js';
import Project from '../../modules/projects/project.model.js';
import Playlist from '../../modules/playlists/playlist.model.js';
import type { IProject } from '../../modules/projects/project.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';
import { requirePermission } from './auth-guards.js';
import { hasPermission, rankOf, ROLE_RANK } from '../../shared/permissions.js';
import { toggleShadowBan } from '../../modules/admin/admin.service.js';
import AccountNameHistory from '../../modules/users/account-name-history.model.js';
import { findUserByAccountName, isAccountNameInHistoryOfOther, recordAccountNameChange } from '../../modules/users/account-name.service.js';
import { isReservedAccountName } from '../../modules/auth/auth.validation.js';
import EmailHistory from '../../modules/users/email-history.model.js';
import { sendVerification, resendVerification } from '../../modules/email-verification/email-verification.service.js';
import Follow from '../../modules/users/follow.model.js';
import Session from '../../modules/auth/session.model.js';
import {
  blockUser as svcBlockUser,
  unblockUser as svcUnblockUser,
  listBlocked,
  getBlockedSet,
  isHiddenByBlock,
  hasBlocked,
  isBlockedEitherWay,
} from '../../modules/blocks/block.service.js';
import { upsertFollow } from '../../modules/notifications/notifications.service.js';
import { getIO } from '../../socket/socket.manager.js';
import { searchUsers as searchUsersService } from '../../modules/users/users.search.service.js';
import { writeActivity, getPublicActivityHeatmap } from '../../modules/activity/activity.service.js';
import { triggerBadgeCheck, getBadgeRarity, getShowcaseSlots, getStreakView } from '../../modules/badges/badge.service.js';
import BadgeDefinition from '../../modules/badges/badge-definition.model.js';
import type { IBadgeDefinition } from '../../modules/badges/badge-definition.model.js';
import { stripHtml, sanitizeUrl } from '../../utils/sanitize.js';
import { socialGraph } from '../../lib/social-graph.js';
import { getPreferences, updatePreferences } from '../../modules/user-preferences/user-preferences.service.js';
import { isCountryCode } from '../../utils/countries.js';
import type { IUserPreferences } from '../../modules/user-preferences/user-preferences.model.js';

/** Input shape for updateProfile mutation */
export interface UpdateProfileInput {
  accountName?: string;
  displayName?: string | null;
  email?: string;
  bio?: string;
  avatarUrl?: string | null;
  coverImageUrl?: string | null;
}

/**
 * True if the viewer is the user themselves or an admin. Used to guard `User`
 * field resolvers that expose private data (uploads, settings, full project list,
 * account-name history) — those fields are reachable through Project.user /
 * Upload.user edges that resolve for unauthenticated viewers, so the parent
 * object being present does NOT imply the viewer is authorized to read it.
 */
/** Same step-up the REST /admin/users/:id/(un)shadowban routes require. */
function requireSudo(context: Context): void {
  if (context.hasSudo !== true) throw new mercurius.ErrorWithProps('sudo_required', { code: 'SUDO_REQUIRED' });
}

async function isSelfOrAdmin(user: IUser, context: Context): Promise<boolean> {
  if (!context.userId) return false;
  const selfId = (user._id ?? user.id)?.toString();
  if (selfId && context.userId === selfId) return true;
  const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
  return hasPermission(requester?.permissions, 'users.view');
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export type LeaderboardTimeframe = 'ALL_TIME' | 'MONTH' | 'WEEK';
export type LeaderboardSort = 'RANK' | 'XP' | 'PROJECTS' | 'LINES' | 'STARS' | 'TIME_SYNCED';
export type LeaderboardSortDirection = 'ASC' | 'DESC';

export interface LeaderboardArgs {
  limit?: number;
  offset?: number;
  timeframe?: LeaderboardTimeframe;
  sortBy?: LeaderboardSort;
  sortDir?: LeaderboardSortDirection;
}

export interface LeaderboardUserView {
  id: string;
  accountName?: string;
  displayName: string | null;
  avatarUrl: string | null;
  badges: IUserBadge[];
  stats: Required<IUserStats>;
  streak: ReturnType<typeof getStreakView>;
  progression: { xp: number; level: number };
  projectCount: number;
  totalStarsReceived: number;
  totalForksReceived: number;
  rankScore: number;
  periodXp: number | null;
}

export interface LeaderboardResultView {
  users: LeaderboardUserView[];
  total: number;
  hasMore: boolean;
}

/** One $facet output document from the period (WEEK/MONTH) pipeline. */
interface LeaderboardFacet {
  rows: { periodXp: number; user: IUser }[];
  total: { count: number }[];
}

/**
 * Sortable column -> the User field path(s) it sorts by, in key order.
 * Every entry is backed by a dedicated compound index on User (see
 * modules/users/user.model.ts); keep the two in step when adding a column.
 *
 * TIME_SYNCED sorts by (minutesSynced, secondsSynced) rather than a derived
 * total-seconds field because recomputeSyncStats stores secondsSynced as the
 * remainder (always 0..59), which makes the pair equivalent to total seconds.
 */
const LEADERBOARD_SORT_FIELDS: Record<LeaderboardSort, readonly string[]> = {
  RANK: ['rankScore', 'stats.syncedLines'],
  XP: ['progression.xp'],
  PROJECTS: ['projectCount'],
  LINES: ['stats.syncedLines'],
  STARS: ['social.totalStarsReceived'],
  TIME_SYNCED: ['stats.minutesSynced', 'stats.secondsSynced'],
};

/**
 * The leaderboard is a discovery surface, so it hides the same users explore
 * and user search hide: deactivated, banned, and search-shadow-banned. It
 * filtered only `isDeleted` before, which left a banned user publicly ranked
 * and gave a shadow-banned user a public placement — defeating the shadow ban.
 *
 * Kept as one constant so the ALL_TIME find() and the windowed aggregation
 * cannot drift apart; `LEADERBOARD_VISIBLE_PREFIXED` is the same predicate for
 * the pipeline, where the user document sits under `user`.
 */
const LEADERBOARD_VISIBLE = {
  isDeleted: { $ne: true },
  'ban.active': { $ne: true },
  'shadowBan.search': { $ne: true },
} as const;

const LEADERBOARD_VISIBLE_PREFIXED = {
  'user.isDeleted': { $ne: true },
  'user.ban.active': { $ne: true },
  'user.shadowBan.search': { $ne: true },
} as const;

/**
 * Builds the sort document for a leaderboard page.
 *
 * `_id` is appended as the final key in every case, and that is load-bearing,
 * not cosmetic: the client pages with `offset`, and offset pagination over a
 * sort with ties has no defined order within a tie group, so rows can be
 * repeated or skipped entirely between two pages. `_id` is unique, so it makes
 * the total order deterministic.
 *
 * ASC reverses every key, tiebreaks included, which is exactly a backward scan
 * of the same index — so one index per column serves both directions.
 *
 * @param prefix  path prefix for the user fields (the aggregation path keeps
 *                them under the looked-up `user` document).
 * @param xpField field holding XP for this path — `progression.xp` all-time,
 *                the windowed `periodXp` for WEEK/MONTH.
 */
function buildLeaderboardSort(
  sortBy: LeaderboardSort,
  dir: 1 | -1,
  prefix = '',
  xpField?: string
): Record<string, 1 | -1> {
  const sort: Record<string, 1 | -1> = {};
  if (sortBy === 'XP' && xpField) {
    sort[xpField] = dir;
  } else {
    for (const field of LEADERBOARD_SORT_FIELDS[sortBy] ?? LEADERBOARD_SORT_FIELDS.RANK) {
      sort[`${prefix}${field}`] = dir;
    }
  }
  sort._id = dir;
  return sort;
}

/**
 * `projectCount` is read from the denormalized `User.projectCount`, NOT from a
 * per-page Project aggregation as it was before.
 *
 * The aggregation was marginally fresher, but it produced the number *shown*
 * while a different number (the denormalized field) produced the *ordering* —
 * so with PROJECTS sorting, a row could legitimately display a lower count than
 * the row beneath it and read as a bug. The displayed value agreeing with the
 * visible ordering is worth more than up-to-the-second accuracy here, and the
 * field is kept live by $inc on project create/clone/delete and reconciled
 * hourly from the authoritative aggregation by the leaderboard-ranking job.
 * It also saves an extra round trip per page on every timeframe.
 */
function toLeaderboardUser(u: IUser, periodXp: number | null): LeaderboardUserView {
  return {
    id: u._id.toString(),
    accountName: u.accountName,
    displayName: u.displayName ?? null,
    avatarUrl: u.avatarUrl ?? null,
    badges: u.badges ?? [],
    stats: {
      minutesSynced: u.stats?.minutesSynced ?? 0,
      secondsSynced: u.stats?.secondsSynced ?? 0,
      wordsSynced: u.stats?.wordsSynced ?? 0,
      karaokeLines: u.stats?.karaokeLines ?? 0,
      syncedLines: u.stats?.syncedLines ?? 0,
      aiSyncedLines: u.stats?.aiSyncedLines ?? 0,
      aiWordsSynced: u.stats?.aiWordsSynced ?? 0,
    },
    streak: getStreakView(u.streak),
    progression: { xp: u.progression?.xp ?? 0, level: u.progression?.level ?? 0 },
    projectCount: u.projectCount ?? 0,
    totalStarsReceived: u.social?.totalStarsReceived ?? 0,
    totalForksReceived: u.social?.totalForksReceived ?? 0,
    rankScore: u.rankScore ?? 0,
    periodXp,
  };
}

export const userResolvers = {
  Query: {
    me: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      const uid = context.userId || context.bannedUserId;
      if (!uid) return null;
      const user = await User.findById(uid);
      if (!user) return null;
      const wasJustUnbanned = await user.checkBanStatus();
      const pub = user.toPublic() as Record<string, unknown>;
      if (wasJustUnbanned) pub.wasJustUnbanned = true;

      const latestSession = await Session.findOne({ userId: user._id })
        .sort({ lastUsedAt: -1 })
        .lean();

      if (latestSession) {
        pub.lastIp = latestSession.ip;
        pub.lastDevice = latestSession.deviceName;
        pub.lastLoginAt = latestSession.createdAt ? latestSession.createdAt.toISOString() : null;
      }

      return pub;
    },

    myMusicLibrary: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) return [];
      const user = await User.findById(context.userId).select('musicLibrary').lean<IUser>();
      const entries = user?.musicLibrary ?? [];
      return [...entries]
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .map((e) => ({
          artist: e.artist || '',
          album: e.album || '',
          genre: e.genre || null,
          language: e.language || null,
          trackCount: e.trackCount ?? null,
          updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : null,
        }));
    },

    blockedUsers: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) return [];
      return listBlocked(context.userId);
    },

    myPreferences: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      return getPreferences(context.userId);
    },

    publicProfile: async (
      _root: unknown,
      { accountName, asVisitor }: { accountName: string; asVisitor?: boolean | null },
      context: Context
    ) => {
      // Old account names keep resolving; the payload carries the current one so
      // the client can redirect to it.
      const user = await findUserByAccountName<IUser>(accountName);
      if (!user || user.isDeleted || user.ban?.active) return null;

      // asVisitor: project the profile exactly as an anonymous visitor sees it
      // (owner's "view as others" preview). It can only remove data, never add.
      const viewerId = asVisitor ? null : (context.userId ?? null);

      // A user blocked by the profile owner cannot view that profile; a user the
      // viewer blocked shows as a name only, with nothing they made or said.
      if (context.userId && context.userId !== user._id.toString()) {
        if (await hasBlocked(user._id.toString(), context.userId)) return null;
        if (await hasBlocked(context.userId, user._id.toString())) return blockedProfileStub(user);
      }

      const isOwner = !!viewerId && viewerId === user._id.toString();
      const projectFilter = isOwner ? { userId: user._id } : { userId: user._id, public: true };

      const playlistFilter = isOwner ? { userId: user._id } : { userId: user._id, isPublic: true };

      const [projects, projectCount, playlistCount, socialTotals] = await Promise.all([
        Project.find(projectFilter)
          .sort({ starCount: -1 })
          .limit(50)
          .lean<IProject[]>(),
        Project.countDocuments(projectFilter),
        Playlist.countDocuments(playlistFilter),
        // Summed over every project the viewer may see, not just the 50 returned.
        Project.aggregate<{ stars: number; forks: number }>([
          { $match: projectFilter },
          { $group: { _id: null, stars: { $sum: { $ifNull: ['$starCount', 0] } }, forks: { $sum: { $ifNull: ['$forkCount', 0] } } } },
        ]),
      ]);

      const totalStarsReceived = socialTotals[0]?.stars ?? 0;
      const totalForksReceived = socialTotals[0]?.forks ?? 0;

      const [isFollowedByMe, isFollowingMe] = await Promise.all([
        viewerId
          ? Follow.exists({ followerId: new mongoose.Types.ObjectId(viewerId), followingId: user._id }).then(Boolean)
          : Promise.resolve(false),
        viewerId
          ? Follow.exists({ followerId: user._id, followingId: new mongoose.Types.ObjectId(viewerId) }).then(Boolean)
          : Promise.resolve(false),
      ]);

      const followNotify = viewerId && isFollowedByMe
        ? ((await Follow.findOne({ followerId: new mongoose.Types.ObjectId(viewerId), followingId: user._id }).select('notify').lean<{ notify?: string }>())?.notify ?? 'off')
        : 'off';

      const isBlockedByMe = viewerId && !isOwner
        ? await hasBlocked(viewerId, user._id.toString())
        : false;

      // Resolve showcasedBadges with rarity data — hidden if owner disabled visibility
      const showcaseVisible = user.showcasePublic !== false || isOwner;
      const showcasedIds: string[] = showcaseVisible ? (user.showcasedBadges ?? []) : [];
      const showcasedBadges = showcasedIds.length > 0
        ? await (async () => {
            const defs = await BadgeDefinition.find({ id: { $in: showcasedIds } }).lean<IBadgeDefinition[]>();
            const defMap = new Map<string, IBadgeDefinition>(defs.map(d => [d.id, d]));
            const ownedMap = new Map<string, IUserBadge>(
              (user.badges ?? []).map((b: IUserBadge) => [b.id, b])
            );
            return Promise.all(
              showcasedIds
                .filter(id => ownedMap.has(id))
                .map(async (id) => {
                  const def = defMap.get(id);
                  if (!def) return null;
                  const { rarity, holderCount } = await getBadgeRarity(id);
                  const badge = ownedMap.get(id);
                  return {
                    id,
                    label: def.label,
                    icon: def.icon,
                    color: def.color,
                    rarity,
                    rarityPct: 0,
                    holderCount,
                    grantedAt: badge?.grantedAt ? new Date(badge.grantedAt).toISOString() : new Date().toISOString(),
                  };
                })
            ).then(r => r.filter(Boolean));
          })()
        : [];

      return {
        id: user._id.toString(),
        accountName: user.accountName,
        displayName: user.displayName ?? null,
        avatarUrl: user.avatarUrl ?? null,
        coverImageUrl: user.coverImageUrl ?? null,
        bio: user.bio ?? null,
        isVerified: user.isVerified ?? false,
        isAdmin: rankOf(user.role) >= ROLE_RANK.admin,
        createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
        projects,
        projectCount,
        playlistCount,
        totalStarsReceived,
        totalForksReceived,
        followerCount: user.social?.followerCount ?? 0,
        followingCount: user.social?.followingCount ?? 0,
        isFollowedByMe,
        followNotify,
        isFollowingMe,
        isBlockedByMe,
        miniProfileBadgeIds: [],   // overridden by User.miniProfileBadgeIds field resolver
        showFollowers: true,        // overridden by User.showFollowers field resolver
        badges: user.badges ?? [],
        showcasedBadges,
        showcasePublic: showcaseVisible,
        stats: { minutesSynced: user.stats?.minutesSynced ?? 0, wordsSynced: user.stats?.wordsSynced ?? 0, karaokeLines: user.stats?.karaokeLines ?? 0, syncedLines: user.stats?.syncedLines ?? 0, aiSyncedLines: user.stats?.aiSyncedLines ?? 0, aiWordsSynced: user.stats?.aiWordsSynced ?? 0 },
        streak: getStreakView(user.streak),
        progression: { xp: user.progression?.xp ?? 0, level: user.progression?.level ?? 0 },
        lastIp: user.lastIp,
        lastOnlineAt: user.lastOnlineAt,
        asVisitor: !!asVisitor,
      };
    },

    searchUsers: async (_root: unknown, { query, limit = 10 }: { query: string; limit?: number }, context: Context) => {
      const results = await searchUsersService(query, limit);
      if (!context.userId) return results;
      const blockedSet = await getBlockedSet(context.userId);
      return blockedSet.size > 0
        ? (results as { id: string }[]).filter((u) => !blockedSet.has(u.id))
        : results;
    },

    leaderboard: async (
      _root: unknown,
      { limit = 25, offset = 0, timeframe = 'ALL_TIME', sortBy = 'RANK', sortDir = 'DESC' }: LeaderboardArgs,
      context: Context,
    ): Promise<LeaderboardResultView> => {
      const cap = Math.max(1, Math.min(limit ?? 25, 50));
      // Users in a block relationship with the viewer are left off the board.
      const blockedIds = [...await getBlockedSet(context?.userId)].map((id) => new mongoose.Types.ObjectId(id));
      const visible = blockedIds.length > 0 ? { ...LEADERBOARD_VISIBLE, _id: { $nin: blockedIds } } : LEADERBOARD_VISIBLE;
      const skip = Math.max(0, offset ?? 0);
      const dir: 1 | -1 = sortDir === 'ASC' ? 1 : -1;

      // ── ALL_TIME: indexed find, no XP window ──────────────────────────────
      if (timeframe === 'ALL_TIME') {
        const [users, total] = await Promise.all([
          User.find(visible)
            .sort(buildLeaderboardSort(sortBy, dir))
            .skip(skip)
            .limit(cap + 1)
            .select('_id accountName displayName avatarUrl badges stats streak progression social rankScore projectCount')
            .lean<IUser[]>(),
          User.countDocuments(visible),
        ]);

        const hasMore = users.length > cap;
        return {
          users: users.slice(0, cap).map((u) => toLeaderboardUser(u, null)),
          total,
          hasMore,
        };
      }

      // ── WEEK / MONTH: XP earned inside a ROLLING window ───────────────────
      // Deliberately rolling (now − 7d / now − 30d), not a calendar week or
      // calendar month: a calendar board resets to near-empty every Monday /
      // 1st of the month, and the reset time would be timezone-dependent for a
      // global user base. A rolling window always covers a full period.
      //
      // Users with no XP movement in the window are legitimately absent — this
      // board ranks activity in the period, not lifetime standing, so `total`
      // counts only users who moved.
      const windowDays = timeframe === 'WEEK' ? 7 : 30;
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

      // In this path the user fields live under the looked-up `user` doc; the
      // period XP total is top-level, and `_id` is the userId from $group, so
      // it still works as the final tiebreak.
      const sortStage = buildLeaderboardSort(sortBy, dir, 'user.', 'periodXp');

      const basePipeline: mongoose.PipelineStage[] = [
        { $match: { createdAt: { $gte: cutoff } } },
        { $group: { _id: '$userId', periodXp: { $sum: '$delta' } } },
        { $match: blockedIds.length > 0 ? { periodXp: { $gt: 0 }, _id: { $nin: blockedIds } } : { periodXp: { $gt: 0 } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        // $unwind drops rows whose lookup found nothing (deleted/purged user).
        { $unwind: '$user' },
        { $match: LEADERBOARD_VISIBLE_PREFIXED },
        // Trim before $sort: the sort runs over every user who moved in the
        // window, and full user documents (badges, musicLibrary, …) would blow
        // the in-memory sort budget for no benefit.
        {
          $project: {
            periodXp: 1,
            'user._id': 1,
            'user.accountName': 1,
            'user.displayName': 1,
            'user.avatarUrl': 1,
            'user.badges': 1,
            'user.stats': 1,
            'user.streak': 1,
            'user.progression': 1,
            'user.social': 1,
            'user.rankScore': 1,
            'user.projectCount': 1,
          },
        },
        { $sort: sortStage },
      ];

      const [faceted] = await XPEvent.aggregate<LeaderboardFacet>([
        ...basePipeline,
        {
          $facet: {
            rows: [{ $skip: skip }, { $limit: cap + 1 }],
            total: [{ $count: 'count' }],
          },
        },
      ]).allowDiskUse(true);

      const rows = faceted?.rows ?? [];
      const hasMore = rows.length > cap;

      return {
        users: rows.slice(0, cap).map((r) => toLeaderboardUser(r.user, r.periodXp)),
        total: faceted?.total?.[0]?.count ?? 0,
        hasMore,
      };
    },

    followList: async (
      _root: unknown,
      { accountName, type, offset = 0 }: { accountName: string; type: 'FOLLOWERS' | 'FOLLOWING' | 'FRIENDS'; offset?: number },
      context: Context
    ) => {
      const user = await findUserByAccountName<IUser>(accountName);
      if (!user || user.isDeleted || user.ban?.active) return { users: [], total: 0 };
      if (await isHiddenByBlock(context.userId, user._id)) return { users: [], total: 0 };
      const isOwner = context.userId && context.userId === user._id.toString();
      const prefs = await getPreferences(user._id.toString());
      if (!prefs.showFollowers && !isOwner) return { users: [], total: 0 };

      // Hide users in a block relationship with the viewer (either direction).
      const blockedSet = await getBlockedSet(context.userId);

      const LIMIT = 50;

      if (type === 'FOLLOWERS') {
        const follows = await Follow.find({ followingId: user._id })
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(LIMIT)
          .lean();
        const followerIds = follows.map(f => f.followerId);
        const users = await User.find({ _id: { $in: followerIds }, isDeleted: { $ne: true } })
          .select('accountName displayName avatarUrl')
          .lean<IUser[]>();

        // Batch-check which followers the viewer already follows back
        const myFollowedSet = new Set<string>();
        if (context.userId && followerIds.length > 0) {
          const myFollows = await Follow.find({
            followerId: new mongoose.Types.ObjectId(context.userId),
            followingId: { $in: followerIds },
          }).select('followingId').lean();
          myFollows.forEach(f => myFollowedSet.add(f.followingId.toString()));
        }

        return {
          users: users.filter(u => !blockedSet.has(u._id.toString())).map(u => ({
            id: u._id.toString(),
            accountName: u.accountName,
            displayName: u.displayName ?? null,
            avatarUrl: u.avatarUrl ?? null,
            isFollowedByMe: myFollowedSet.has(u._id.toString()),
          })),
          total: user.social?.followerCount ?? 0,
        };
      } else if (type === 'FOLLOWING') {
        const follows = await Follow.find({ followerId: user._id })
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(LIMIT)
          .lean();
        const followingIds = follows.map(f => f.followingId);
        const users = await User.find({ _id: { $in: followingIds }, isDeleted: { $ne: true } })
          .select('accountName displayName avatarUrl')
          .lean<IUser[]>();

        // Batch-check which following users the viewer also follows
        const myFollowedSet = new Set<string>();
        if (context.userId && followingIds.length > 0) {
          const myFollows = await Follow.find({
            followerId: new mongoose.Types.ObjectId(context.userId),
            followingId: { $in: followingIds },
          }).select('followingId').lean();
          myFollows.forEach(f => myFollowedSet.add(f.followingId.toString()));
        }

        return {
          users: users.filter(u => !blockedSet.has(u._id.toString())).map(u => ({
            id: u._id.toString(),
            accountName: u.accountName,
            displayName: u.displayName ?? null,
            avatarUrl: u.avatarUrl ?? null,
            isFollowedByMe: myFollowedSet.has(u._id.toString()),
          })),
          total: user.social?.followingCount ?? 0,
        };
      } else {
        // FRIENDS: mutual follows — people user follows who also follow back
        const following = await Follow.find({ followerId: user._id })
          .select('followingId').lean();
        const followingIds = following.map(f => f.followingId);
        if (followingIds.length === 0) return { users: [], total: 0 };

        const mutualFollows = await Follow.find({
          followerId: { $in: followingIds },
          followingId: user._id,
        }).select('followerId').lean();

        const mutualIds = mutualFollows.map(f => f.followerId);
        const pagedMutualIds = mutualIds.slice(offset, offset + 50);

        const users = await User.find({
          _id: { $in: pagedMutualIds },
          isDeleted: { $ne: true },
        })
          .select('accountName displayName avatarUrl')
          .lean<IUser[]>();

        const myFollowedSet = new Set<string>();
        if (context.userId && pagedMutualIds.length > 0) {
          const myFollows = await Follow.find({
            followerId: new mongoose.Types.ObjectId(context.userId),
            followingId: { $in: pagedMutualIds },
          }).select('followingId').lean();
          myFollows.forEach(f => myFollowedSet.add(f.followingId.toString()));
        }

        return {
          users: users.filter(u => !blockedSet.has(u._id.toString())).map(u => ({
            id: u._id.toString(),
            accountName: u.accountName,
            displayName: u.displayName ?? null,
            avatarUrl: u.avatarUrl ?? null,
            isFollowedByMe: myFollowedSet.has(u._id.toString()),
          })),
          total: mutualIds.length,
        };
      }
    },
  },

  Mutation: {
    updateProfile: async (_root: unknown, { input }: { input: UpdateProfileInput }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const user = await User.findById(context.userId);
      if (!user) throw new Error('User not found');

      const { accountName, displayName, email, bio, avatarUrl, coverImageUrl } = input;

      if (accountName && accountName.toLowerCase().trim() !== user.accountName) {
        const COOLDOWN_DAYS = 7;
        if (user.lastAccountNameChangedAt && rankOf(user.role) < ROLE_RANK.admin) {
          const daysSince = (Date.now() - (user.lastAccountNameChangedAt as Date).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < COOLDOWN_DAYS) {
            const daysLeft = Math.ceil(COOLDOWN_DAYS - daysSince);
            throw Object.assign(new Error('accountName_change_cooldown'), { extensions: { code: 'accountName_change_cooldown', daysLeft, status: 429 } });
          }
        }
        const normalised = accountName.toLowerCase().trim();
        if (!/^[a-z0-9_-]{3,30}$/.test(normalised)) throw new Error('accountName_invalid');
        const existing = (await User.findOne({ accountName: normalised }))
          || isReservedAccountName(normalised)
          || (await isAccountNameInHistoryOfOther(normalised, user._id));
        if (existing) throw Object.assign(new Error('accountName_taken'), { extensions: { code: 'accountName_taken', status: 409 } });
        const previousAccountName = user.accountName;
        user.accountName = normalised;
        user.lastAccountNameChangedAt = new Date();
        if (previousAccountName) await recordAccountNameChange(user._id, previousAccountName, normalised);
      }

      if (displayName !== undefined) {
        user.displayName = displayName ? stripHtml(displayName.trim()).slice(0, 50) : null;
      }

      if (email && email.toLowerCase().trim() !== user.email && email.toLowerCase().trim() !== user.pendingEmail) {
        const normalised = email.toLowerCase().trim();
        const existing = await User.findOne({ $or: [{ email: normalised }, { pendingEmail: normalised }] });
        if (existing) throw new Error('Email already in use');
        user.pendingEmail = normalised;
        sendVerification(context.userId, normalised, 'email_change').catch(() => {});
      }

      if (bio !== undefined) {
        user.bio = stripHtml(bio.trim()).slice(0, 160);
      }

      if (avatarUrl !== undefined) {
        user.avatarUrl = avatarUrl !== null ? sanitizeUrl(avatarUrl) : null;
      }

      if (coverImageUrl !== undefined) {
        user.coverImageUrl = coverImageUrl !== null ? sanitizeUrl(coverImageUrl) : null;
      }

      await user.save();
      return user.toPublic();
    },

    sendVerificationEmail: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await resendVerification(context.userId);
      return true;
    },

    follow: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');

      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!target || target.isDeleted || target.ban?.active) throw new Error('User not found');

      const targetId = target._id.toString();
      if (targetId === context.userId) throw new Error('Cannot follow yourself');

      if (await isBlockedEitherWay(context.userId, targetId)) throw new Error('Cannot follow this user');

      try {
        await Follow.create({
          followerId: new mongoose.Types.ObjectId(context.userId),
          followingId: target._id,
        });
        await Promise.all([
          User.updateOne({ _id: target._id }, { $inc: { 'social.followerCount': 1 } }),
          User.updateOne({ _id: new mongoose.Types.ObjectId(context.userId) }, { $inc: { 'social.followingCount': 1 } }),
        ]);
        const follower = await User.findById(context.userId).lean<IUser>();
        if (follower) {
          upsertFollow({
            ownerId: targetId,
            actorId: context.userId,
            actorAccountName: follower.accountName ?? '',
            actorAvatarUrl: follower.avatarUrl ?? null,
          }).catch(() => {});

          try {
            getIO().to(`user:${targetId}`).emit('follow:new', {
              followerId: context.userId,
              accountName: follower.accountName ?? '',
              avatarUrl: follower.avatarUrl ?? null,
              followerCount: (target.social?.followerCount ?? 0) + 1,
            });
          } catch {}

          // fan-out follow activity — fire and forget
          writeActivity({
            actorId: context.userId,
            type: 'user_followed',
            publicId: '',
            projectTitle: target.displayName || target.accountName || '',
            coverImage: target.avatarUrl ?? '',
            targetPath: `/${target.accountName ?? ''}`,
          }).catch(() => {});
        }
      } catch (err: unknown) {
        // MongoDB duplicate key — already following, treat as idempotent
        if (typeof err === 'object' && err !== null && 'code' in err && (err as Record<string, unknown>).code === 11000) return true;
        throw err;
      }
      // Graph is updated only here — after successful DB insert (dup-key path returns inside catch above)
      socialGraph.addEdge(context.userId, targetId);
      // Badge: follower_count for the target
      triggerBadgeCheck(targetId, 'follow_received').catch(() => {});
      return true;
    },

    setFollowNotify: async (_root: unknown, { accountName, level }: { accountName: string; level: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      if (level !== 'off' && level !== 'uploads' && level !== 'all') throw new Error('Invalid level');
      const target = await User.findOne({ accountName: accountName.toLowerCase() }).select('_id').lean<IUser>();
      if (!target) throw new Error('User not found');
      // Only an existing follow can carry a level; nothing is created here.
      const result = await Follow.updateOne(
        { followerId: new mongoose.Types.ObjectId(context.userId), followingId: target._id },
        { $set: { notify: level } },
      );
      if (result.matchedCount === 0) throw new Error('Not following this user');
      return true;
    },

    unfollow: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');

      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!target) return true;

      const result = await Follow.deleteOne({
        followerId: new mongoose.Types.ObjectId(context.userId),
        followingId: target._id,
      });

      if (result.deletedCount > 0) {
        await Promise.all([
          User.updateOne(
            { _id: target._id, 'social.followerCount': { $gt: 0 } },
            { $inc: { 'social.followerCount': -1 } }
          ),
          User.updateOne(
            { _id: new mongoose.Types.ObjectId(context.userId), 'social.followingCount': { $gt: 0 } },
            { $inc: { 'social.followingCount': -1 } }
          ),
        ]);
        socialGraph.removeEdge(context.userId, target._id.toString());
      }
      return true;
    },

    blockUser: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!target) throw new Error('User not found');
      const targetId = target._id.toString();
      if (targetId === context.userId) throw new Error('Cannot block yourself');
      await svcBlockUser(context.userId, targetId);
      refreshNotifications(context.userId, targetId);
      return true;
    },

    unblockUser: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!target) return true;
      await svcUnblockUser(context.userId, target._id.toString());
      refreshNotifications(context.userId, target._id.toString());
      return true;
    },

    adminShadowBan: async (_root: unknown, { userId, feed, search, reason }: { userId: string; feed: boolean; search: boolean; reason?: string | null }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'users.shadowban');
      requireSudo(context);
      const result = await toggleShadowBan(userId, feed, search, reason ?? null, adminId, context.ip);
      return result.success === true;
    },

    adminUnshadowBan: async (_root: unknown, { userId }: { userId: string }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'users.shadowban');
      requireSudo(context);
      const result = await toggleShadowBan(userId, false, false, null, adminId, context.ip);
      return result.success === true;
    },

    updatePreferences: async (_root: unknown, { input }: { input: Record<string, unknown> }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');

      if (input.onlineVisibility !== undefined) {
        const valid = ['everyone', 'friends', 'nobody'];
        if (!valid.includes(input.onlineVisibility as string)) {
          throw new Error('Invalid onlineVisibility value');
        }
      }
      if (input.lastOnlineVisibility !== undefined) {
        const valid = ['everyone', 'friends', 'nobody'];
        if (!valid.includes(input.lastOnlineVisibility as string)) {
          throw new Error('Invalid lastOnlineVisibility value');
        }
      }
      if (input.countryVisibility !== undefined) {
        const valid = ['everyone', 'friends', 'nobody'];
        if (!valid.includes(input.countryVisibility as string)) {
          throw new Error('Invalid countryVisibility value');
        }
      }
      // The user's own choice; null clears it. Never derived from their IP.
      if (input.country !== undefined && input.country !== null && !isCountryCode(input.country)) {
        throw new Error('Invalid country value');
      }

      if (Array.isArray(input.miniProfileBadgeIds) && (input.miniProfileBadgeIds as string[]).length > 3) {
        throw new Error('Maximum 3 mini profile badges allowed');
      }

      if (input.miniProfileBadgeIds !== undefined) {
        const user = await User.findById(context.userId).select('badges').lean<IUser>();
        if (!user) throw new Error('User not found');
        const ownedIds = new Set((user.badges ?? []).map((b: IUserBadge) => b.id));
        input.miniProfileBadgeIds = (input.miniProfileBadgeIds as string[]).filter(id => ownedIds.has(id));
      }

      return updatePreferences(context.userId, input as Partial<IUserPreferences>);
    },
  },

  User: {
    id: (user: IUser) => user._id?.toString() ?? user.id,
    // Owner-only: a user's permission set is returned solely to themselves.
    // For every other viewer (public User edges like Project.user, Upload.user,
    // or staff browsing) this resolves to [] regardless of what the query
    // projected — confidentiality is enforced here, not by projection discipline
    // at each call site.
    permissions: (user: IUser, _args: unknown, context: Context) => {
      const selfId = (user._id ?? user.id)?.toString();
      return context?.userId && selfId === context.userId ? (user.permissions ?? []) : [];
    },
    createdAt: (user: IUser) => user.createdAt ? new Date(user.createdAt).toISOString() : null,
    badges:          (user: IUser) => user.badges ?? [],
    showcasedBadges: (user: IUser) => user.showcasedBadges ?? [],
    stats:           (user: IUser) => ({ minutesSynced: user.stats?.minutesSynced ?? 0, wordsSynced: user.stats?.wordsSynced ?? 0, karaokeLines: user.stats?.karaokeLines ?? 0, syncedLines: user.stats?.syncedLines ?? 0, aiSyncedLines: user.stats?.aiSyncedLines ?? 0, aiWordsSynced: user.stats?.aiWordsSynced ?? 0 }),
    showcasePublic:  (user: IUser) => user.showcasePublic !== false,
    streak:          (user: IUser) => getStreakView(user.streak),
    progression:     (user: IUser) => ({ xp: user.progression?.xp ?? 0, level: user.progression?.level ?? 0 }),
    showcaseSlots:   (user: IUser) => getShowcaseSlots(user.progression?.level ?? 0),

    // The `User` type is reachable through edges (Project.user, Upload.user) that
    // resolve for ANY viewer, including unauthenticated ones. Field resolvers that
    // expose private data must therefore re-check the viewer — never assume the
    // parent object was authorized. See isSelfOrAdmin below.
    projects: async (user: IUser, _args: Record<string, unknown>, context: Context) => {
      const ownerId = (user._id ?? user.id);
      // Owner/admin see everything; everyone else only the owner's public projects.
      if (await isSelfOrAdmin(user, context)) return Project.find({ userId: ownerId });
      return Project.find({ userId: ownerId, public: true });
    },
    uploads: async (user: IUser, _args: Record<string, unknown>, context: Context) => {
      if (!(await isSelfOrAdmin(user, context))) return [];
      return Upload.find({ userId: user._id ?? user.id });
    },
    settings: async (user: IUser, _args: Record<string, unknown>, context: Context) => {
      if (!(await isSelfOrAdmin(user, context))) return null;
      return Settings.findOne({ userId: user._id ?? user.id });
    },

    previousAccountNames: async (user: IUser, _args: Record<string, unknown>, context: Context) => {
      if (!(await isSelfOrAdmin(user, context))) return [];
      const docs = await AccountNameHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
      return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
    },

    accountNameChangeCount: async (user: IUser, _args: Record<string, unknown>, context: Context) => {
      if (!(await isSelfOrAdmin(user, context))) return 0;
      return AccountNameHistory.countDocuments({ userId: user._id ?? user.id });
    },

    emailHistory: async (user: IUser, _args: Record<string, unknown>, context: Context) => {
      const selfId = (user._id ?? user.id)?.toString();
      if (context.userId === selfId) {
        const docs = await EmailHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
        return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
      }
      if (context.userId) {
        const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
        if (hasPermission(requester?.permissions, 'users.view')) {
          const docs = await EmailHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
          return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
        }
      }
      return [];
    },

    showFollowers: async (user: IUser & { id?: string }, _args: unknown, context: Context) => {
      const id = (user._id ?? user.id).toString();
      const prefs = await getPreferences(id);
      if (prefs.showFollowers) return true;
      
      if (context.userId && context.userId !== id) {
        const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
        if (hasPermission(requester?.permissions, 'users.view')) return true;
      }
      return false;
    },
    miniProfileBadgesEnabled: async (user: IUser & { id?: string }, _args: unknown, context: Context) => {
      const id = (user._id ?? user.id).toString();
      const prefs = await getPreferences(id);
      if (prefs.miniProfileBadgesEnabled) return true;
      
      if (context.userId && context.userId !== id) {
        const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
        if (hasPermission(requester?.permissions, 'users.view')) return true;
      }
      return false;
    },
    miniProfileBadgeIds: async (user: IUser & { id?: string }, _args: unknown, context: Context) => {
      const id = (user._id ?? user.id).toString();
      const prefs = await getPreferences(id);
      if (prefs.miniProfileBadgesEnabled) return prefs.miniProfileBadgeIds;
      
      if (context.userId && context.userId !== id) {
        const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
        if (hasPermission(requester?.permissions, 'users.view')) return prefs.miniProfileBadgeIds;
      }
      return [];
    },
    onlineVisibility: async (user: IUser & { id?: string }) => {
      const id = (user._id ?? user.id).toString();
      const prefs = await getPreferences(id);
      return prefs.onlineVisibility;
    },
    lastOnlineVisibility: async (user: IUser & { id?: string }) => {
      const id = (user._id ?? user.id).toString();
      const prefs = await getPreferences(id);
      return prefs.lastOnlineVisibility ?? 'friends';
    },
    lastOnlineAt: async (user: IUser & { id?: string }, _args: unknown, context: Context) => {
      if (!user.lastOnlineAt) return null;
      
      const id = (user._id ?? user.id).toString();
      
      if (context.userId === id) return new Date(user.lastOnlineAt).toISOString();
      
      if (context.userId) {
        const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
        if (hasPermission(requester?.permissions, 'users.view')) {
          return new Date(user.lastOnlineAt).toISOString();
        }
      }
      
      const prefs = await getPreferences(id);
      const visibility = prefs.lastOnlineVisibility ?? 'friends';
      
      if (visibility === 'nobody') return null;
      
      if (visibility === 'friends') {
        if (!context.userId) return null;
        
        const mongoose = (await import('mongoose')).default;
        const Follow = (await import('../../modules/users/follow.model.js')).default;
        
        const userOid = new mongoose.Types.ObjectId(id);
        const following = await Follow.find({ followerId: userOid }).select('followingId').lean();
        const followingIds = following.map(f => f.followingId);
        
        let mutualIds: string[] = [];
        if (followingIds.length > 0) {
          const mutuals = await Follow.find({
            followerId: { $in: followingIds },
            followingId: userOid,
          }).select('followerId').lean();
          mutualIds = mutuals.map(f => f.followerId.toString());
        }

        if (!mutualIds.includes(context.userId)) return null;
      }
      
      return new Date(user.lastOnlineAt).toISOString();
    },
    // The country the user chose in settings (preferences.country), never one derived
    // from their IP. They and staff always see it; others per countryVisibility.
    country: async (user: IUser, _args: unknown, context: Context) => {
      const id = (user._id ?? user.id).toString();
      const prefs = await getPreferences(id);
      const country = prefs.country ?? null;
      if (!country) return null;

      if (context.userId === id) return country;

      if (context.userId) {
        const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
        if (hasPermission(requester?.permissions, 'users.view')) return country;
      }

      const visibility = prefs.countryVisibility ?? 'nobody';
      
      if (visibility === 'nobody') return null;
      
      if (visibility === 'friends') {
        if (!context.userId) return null;
        
        const mongoose = (await import('mongoose')).default;
        const Follow = (await import('../../modules/users/follow.model.js')).default;
        
        const userOid = new mongoose.Types.ObjectId(id);
        const following = await Follow.find({ followerId: userOid }).select('followingId').lean();
        const followingIds = following.map(f => f.followingId);
        
        let mutualIds: string[] = [];
        if (followingIds.length > 0) {
          const mutuals = await Follow.find({
            followerId: { $in: followingIds },
            followingId: userOid,
          }).select('followerId').lean();
          mutualIds = mutuals.map(f => f.followerId.toString());
        }

        if (!mutualIds.includes(context.userId)) return null;
      }

      return country;
    },
  },
};

// A block hides notifications in both directions (and an unblock brings them
// back), so both users' open clients refetch their list and unread count.
function refreshNotifications(...userIds: string[]): void {
  try {
    for (const id of userIds) getIO().to(`user:${id}`).emit('notifications:refresh');
  } catch { /* socket not ready */ }
}

type PublicUserParent = IUser & { id?: string; asVisitor?: boolean; blockedStub?: boolean };

/**
 * The profile of someone the viewer blocked: enough to recognise them and undo
 * the block, nothing they made (projects, playlists, badges, bio, cover, stats)
 * and nothing about their presence (country, last seen). Field resolvers that
 * load more see `blockedStub` and return nothing — see `unlessBlocked`.
 */
function blockedProfileStub(user: IUser) {
  return {
    id: user._id.toString(),
    accountName: user.accountName,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    coverImageUrl: null,
    bio: null,
    isVerified: false,
    isAdmin: false,
    createdAt: null,
    projects: [],
    projectCount: 0,
    playlistCount: 0,
    totalStarsReceived: 0,
    totalForksReceived: 0,
    followerCount: 0,
    followingCount: 0,
    isFollowedByMe: false,
    isFollowingMe: false,
    isBlockedByMe: true,
    miniProfileBadgeIds: [],
    showFollowers: false,
    badges: [],
    showcasedBadges: [],
    showcasePublic: false,
    stats: null,
    streak: null,
    progression: null,
    lastOnlineAt: null,
    asVisitor: false,
    blockedStub: true,
  };
}

function unlessBlocked<R, E>(resolver: UserFieldResolver<R>, empty: E): UserFieldResolver<R | E> {
  return (user, args, context) => (user.blockedStub ? Promise.resolve(empty) : resolver(user, args, context));
}
type UserFieldResolver<R> = (user: PublicUserParent, args: unknown, context: Context) => Promise<R>;

/**
 * For `publicProfile(asVisitor: true)` the privacy-sensitive field resolvers run
 * with an anonymous viewer, so the owner's preview matches what visitors get.
 */
function asViewer<R>(resolver: UserFieldResolver<R>): UserFieldResolver<R> {
  return (user, args, context) =>
    resolver(user, args, user.asVisitor ? { ...context, userId: null } : context);
}

// FollowUser rows carry no IP, so country loads it here and then defers to the
// one User.country resolver: the visibility rules must not exist in two places.
// Costs a few queries per row, which is why only the search results page asks for it.
export const followUserResolvers = {
  country: async (parent: { id?: string }, args: unknown, context: Context) => {
    if (!parent.id || !mongoose.isValidObjectId(parent.id)) return null;
    const user = await User.findById(parent.id).select('lastIp').lean<IUser>();
    if (!user) return null;
    return userResolvers.User.country(user, args, context);
  },
};

// PublicUser reuses the same field resolvers as User (privacy/permission logic is identical)
export const publicUserResolvers = {
  showFollowers: unlessBlocked(asViewer(userResolvers.User.showFollowers), false),
  miniProfileBadgeIds: unlessBlocked(asViewer(userResolvers.User.miniProfileBadgeIds), []),
  lastOnlineAt: unlessBlocked(asViewer(userResolvers.User.lastOnlineAt), null),
  country: unlessBlocked(asViewer(userResolvers.User.country), null),
  activityHeatmap: unlessBlocked(async (user) => getPublicActivityHeatmap(String(user.id)), null),
  showXpProgress: unlessBlocked(async (user) => (await getPreferences(String(user.id))).showXpProgress, false),
};

