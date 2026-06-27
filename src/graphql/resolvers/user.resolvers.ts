import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import type { IUser, IUserBadge } from '../../db/user.model.js';
import Project from '../../modules/projects/project.model.js';
import type { IProject } from '../../modules/projects/project.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';
import { requirePermission } from './auth-guards.js';
import { hasPermission, rankOf, ROLE_RANK } from '../../shared/permissions.js';
import { logAdminAction, toggleShadowBan } from '../../modules/admin/admin.service.js';
import AccountNameHistory from '../../db/account-name-history.model.js';
import EmailHistory from '../../db/email-history.model.js';
import { sendVerification, resendVerification } from '../../modules/email-verification/email-verification.service.js';
import Follow from '../../db/follow.model.js';
import {
  blockUser as svcBlockUser,
  unblockUser as svcUnblockUser,
  listBlocked,
  getBlockedSet,
  hasBlocked,
  isBlockedEitherWay,
} from '../../modules/blocks/block.service.js';
import { upsertFollow } from '../../modules/notifications/notifications.service.js';
import { searchUsers as searchUsersService } from '../../modules/users/users.search.service.js';
import { writeActivity } from '../../modules/activity/activity.service.js';
import { triggerBadgeCheck, updateShowcase, getBadgeRarity, getShowcaseSlots } from '../../modules/badges/badge.service.js';
import BadgeDefinition from '../../modules/badges/badge-definition.model.js';
import type { IBadgeDefinition } from '../../modules/badges/badge-definition.model.js';
import { stripHtml, sanitizeUrl } from '../../utils/sanitize.js';
import { socialGraph } from '../../lib/social-graph.js';
import { getPreferences, updatePreferences } from '../../modules/user-preferences/user-preferences.service.js';
import type { IUserPreferences } from '../../db/user-preferences.model.js';

/** Input shape for updateProfile mutation */
export interface UpdateProfileInput {
  accountName?: string;
  displayName?: string | null;
  email?: string;
  bio?: string;
  avatarUrl?: string | null;
}

export interface BadgeInput {
  id?: string;
  label?: { en: string; es?: string };
  description?: { en: string; es?: string };
  icon?: string;
  color?: string;
  conditionType?: string;
  conditionValue?: number | null;
  autoGrant?: boolean;
  xpReward?: number;
}

/**
 * True if the viewer is the user themselves or an admin. Used to guard `User`
 * field resolvers that expose private data (uploads, settings, full project list,
 * account-name history) — those fields are reachable through Project.user /
 * Upload.user edges that resolve for unauthenticated viewers, so the parent
 * object being present does NOT imply the viewer is authorized to read it.
 */
async function isSelfOrAdmin(user: IUser, context: Context): Promise<boolean> {
  if (!context.userId) return false;
  const selfId = (user._id ?? user.id)?.toString();
  if (selfId && context.userId === selfId) return true;
  const requester = await User.findById(context.userId).select('permissions').lean<IUser>();
  return hasPermission(requester?.permissions, 'users.view');
}

export const userResolvers = {
  Query: {
    me: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) return null;
      const user = await User.findById(context.userId);
      if (!user) return null;
      const wasJustUnbanned = await user.checkBanStatus();
      const pub = user.toPublic();
      if (wasJustUnbanned) pub.wasJustUnbanned = true;
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

    publicProfile: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!user || user.isDeleted || user.ban?.active) return null;

      // A user blocked by the profile owner cannot view that profile.
      if (context.userId && context.userId !== user._id.toString()
          && await hasBlocked(user._id.toString(), context.userId)) {
        return null;
      }

      const isOwner = context.userId && context.userId === user._id.toString();
      const projectFilter = isOwner ? { userId: user._id } : { userId: user._id, public: true };

      const [projects, projectCount] = await Promise.all([
        Project.find(projectFilter)
          .sort({ starCount: -1 })
          .limit(50)
          .lean<IProject[]>(),
        Project.countDocuments(projectFilter),
      ]);

      const totalStarsReceived = projects.reduce((sum, p) => sum + (p.starCount ?? 0), 0);
      const totalForksReceived = projects.reduce((sum, p) => sum + (p.forkCount ?? 0), 0);

      const [isFollowedByMe, isFollowingMe] = await Promise.all([
        context.userId
          ? Follow.exists({ followerId: new mongoose.Types.ObjectId(context.userId), followingId: user._id }).then(Boolean)
          : Promise.resolve(false),
        context.userId
          ? Follow.exists({ followerId: user._id, followingId: new mongoose.Types.ObjectId(context.userId) }).then(Boolean)
          : Promise.resolve(false),
      ]);

      const isBlockedByMe = context.userId && !isOwner
        ? await hasBlocked(context.userId, user._id.toString())
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
                  const { rarity, pct, holderCount } = await getBadgeRarity(id);
                  const badge = ownedMap.get(id);
                  return {
                    id,
                    label: def.label,
                    icon: def.icon,
                    color: def.color,
                    rarity,
                    rarityPct: pct,
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
        bio: user.bio ?? null,
        isVerified: user.isVerified ?? false,
        isAdmin: rankOf(user.role) >= ROLE_RANK.admin,
        createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
        projects,
        projectCount,
        totalStarsReceived,
        totalForksReceived,
        followerCount: user.social?.followerCount ?? 0,
        followingCount: user.social?.followingCount ?? 0,
        isFollowedByMe,
        isFollowingMe,
        isBlockedByMe,
        miniProfileBadgeIds: [],   // overridden by User.miniProfileBadgeIds field resolver
        showFollowers: true,        // overridden by User.showFollowers field resolver
        badges: user.badges ?? [],
        showcasedBadges,
        showcasePublic: showcaseVisible,
        stats: { minutesSynced: user.stats?.minutesSynced ?? 0, wordsSynced: user.stats?.wordsSynced ?? 0, karaokeLines: user.stats?.karaokeLines ?? 0 },
        streak: { current: user.streak?.current ?? 0, longest: user.streak?.longest ?? 0, lastActiveDate: user.streak?.lastActiveDate ?? null },
        progression: { xp: user.progression?.xp ?? 0, level: user.progression?.level ?? 0 },
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

    leaderboard: async (_root: unknown, { limit = 25, offset = 0 }: { limit?: number; offset?: number }) => {
      const cap = Math.min(limit, 50);
      const [users, total] = await Promise.all([
        User.find({ isDeleted: { $ne: true } })
          .sort({ 'stats.minutesSynced': -1 })
          .skip(offset)
          .limit(cap + 1)
          .select('_id accountName displayName avatarUrl badges stats streak progression social')
          .lean<IUser[]>(),
        User.countDocuments({ isDeleted: { $ne: true } }),
      ]);

      const hasMore = users.length > cap;
      const page = users.slice(0, cap);

      const projectCounts = await Project.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        { $match: { userId: { $in: page.map(u => u._id) } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ]);
      const pcMap = new Map<string, number>(projectCounts.map(r => [r._id.toString(), r.count]));

      return {
        users: page.map(u => ({
          id: u._id.toString(),
          accountName: u.accountName,
          displayName: u.displayName ?? null,
          avatarUrl: u.avatarUrl ?? null,
          badges: u.badges ?? [],
          stats: { minutesSynced: u.stats?.minutesSynced ?? 0, wordsSynced: u.stats?.wordsSynced ?? 0, karaokeLines: u.stats?.karaokeLines ?? 0 },
          streak: { current: u.streak?.current ?? 0, longest: u.streak?.longest ?? 0, lastActiveDate: u.streak?.lastActiveDate ?? null },
          progression: { xp: u.progression?.xp ?? 0, level: u.progression?.level ?? 0 },
          projectCount: pcMap.get(u._id.toString()) ?? 0,
          totalStarsReceived: u.social?.totalStarsReceived ?? 0,
          totalForksReceived: u.social?.totalForksReceived ?? 0,
        })),
        total,
        hasMore,
      };
    },

    badgeDefinitions: async () => {
      const defs = await BadgeDefinition.find().lean<IBadgeDefinition[]>();
      const [totalUsers, holderCounts] = await Promise.all([
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
    },

    userShowcase: async (_root: unknown, { accountName }: { accountName: string }, _context: Context) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() })
        .select('badges showcasedBadges')
        .lean<IUser>();
      if (!user) return [];

      const ownedMap = new Map<string, IUserBadge>(
        (user.badges ?? []).map((b: IUserBadge) => [b.id, b])
      );

      const showcased = (user.showcasedBadges ?? [])
        .filter((id: string) => ownedMap.has(id));

      if (showcased.length === 0) return [];

      const defs = await BadgeDefinition.find({ id: { $in: showcased } }).lean<IBadgeDefinition[]>();
      const defMap = new Map<string, IBadgeDefinition>(defs.map(d => [d.id, d]));

      return Promise.all(
        showcased.map(async (id: string) => {
          const def = defMap.get(id);
          if (!def) return null;
          const badge = ownedMap.get(id);
          const { rarity, pct, holderCount } = await getBadgeRarity(id);
          return {
            id,
            label: def.label,
            icon: def.icon,
            color: def.color,
            rarity,
            rarityPct: pct,
            holderCount,
            grantedAt: badge?.grantedAt ? new Date(badge.grantedAt).toISOString() : new Date().toISOString(),
          };
        })
      ).then(r => r.filter(Boolean));
    },

    followList: async (
      _root: unknown,
      { accountName, type, offset = 0 }: { accountName: string; type: 'FOLLOWERS' | 'FOLLOWING' | 'FRIENDS'; offset?: number },
      context: Context
    ) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!user || user.isDeleted || user.ban?.active) return { users: [], total: 0 };
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

      const { accountName, displayName, email, bio, avatarUrl } = input;

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
        const existing = await User.findOne({ accountName: normalised });
        if (existing) throw Object.assign(new Error('accountName_taken'), { extensions: { code: 'accountName_taken', status: 409 } });
        const previousAccountName = user.accountName;
        user.accountName = normalised;
        user.lastAccountNameChangedAt = new Date();
        AccountNameHistory.create({ userId: user._id, from: previousAccountName, to: normalised }).catch(() => {});
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
      return true;
    },

    unblockUser: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean<IUser>();
      if (!target) return true;
      await svcUnblockUser(context.userId, target._id.toString());
      return true;
    },

    updateShowcase: async (_root: unknown, { badgeIds, showcasePublic }: { badgeIds: string[]; showcasePublic?: boolean }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await updateShowcase(context.userId, badgeIds, showcasePublic);
      const user = await User.findById(context.userId).select('progression showcasePublic').lean<IUser>();
      const level = user?.progression?.level ?? 0;
      return {
        success: result.success,
        error: result.error ?? null,
        showcaseSlots: getShowcaseSlots(level),
        level,
        showcasePublic: user?.showcasePublic ?? true,
      };
    },

    adminGrantBadge: async (_root: unknown, { userIdentifier, badgeId }: { userIdentifier: string; badgeId: string }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'badges.manage');
      // Accept accountName or MongoDB _id
      let resolvedId = userIdentifier.trim();
      if (!/^[a-f\d]{24}$/i.test(resolvedId)) {
        const target = await User.findOne({ accountName: resolvedId }).select('_id').lean<IUser>();
        if (!target) throw new Error(`User "${resolvedId}" not found`);
        resolvedId = target._id.toString();
      }
      const { grantBadge } = await import('../../modules/badges/badge.service.js');
      const result = await grantBadge(resolvedId, badgeId, adminId);
      logAdminAction({ adminId, action: 'grant_badge', targetId: resolvedId, targetName: badgeId, ip: context.ip }).catch(() => {});
      return result;
    },

    adminRevokeBadge: async (_root: unknown, { userId, badgeId }: { userId: string; badgeId: string }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'badges.manage');
      const { revokeBadge } = await import('../../modules/badges/badge.service.js');
      const result = await revokeBadge(userId, badgeId);
      logAdminAction({ adminId, action: 'revoke_badge', targetId: userId, targetName: badgeId, ip: context.ip }).catch(() => {});
      return result;
    },

    adminCreateBadge: async (_root: unknown, { input }: { input: BadgeInput }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'badges.manage');
      const { createBadgeDef } = await import('../../modules/badges/badge.service.js');
      const def = await createBadgeDef(input, context.userId ?? undefined);
      logAdminAction({ adminId, action: 'create_badge', targetName: String(def.id ?? ''), details: input.label?.en ?? null, ip: context.ip }).catch(() => {});
      return def;
    },

    adminUpdateBadge: async (_root: unknown, { id, input }: { id: string; input: BadgeInput }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'badges.manage');
      const { updateBadgeDef } = await import('../../modules/badges/badge.service.js');
      const def = await updateBadgeDef(id, input);
      logAdminAction({ adminId, action: 'update_badge', targetName: id, ip: context.ip }).catch(() => {});
      return def;
    },

    adminDeleteBadge: async (_root: unknown, { id }: { id: string }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'badges.manage');
      const { deleteBadgeDef } = await import('../../modules/badges/badge.service.js');
      const result = await deleteBadgeDef(id);
      logAdminAction({ adminId, action: 'delete_badge', targetName: id, ip: context.ip }).catch(() => {});
      return result;
    },

    adminRetroactiveScan: async (_root: unknown, { badgeId }: { badgeId: string }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'badges.manage');
      const { retroactiveGrant } = await import('../../modules/badges/badge.service.js');
      const result = await retroactiveGrant(badgeId);
      logAdminAction({ adminId, action: 'retroactive_scan', targetName: badgeId, details: `granted ${result?.granted ?? 0}/${result?.scanned ?? 0}`, ip: context.ip }).catch(() => {});
      return result;
    },

    adminShadowBan: async (_root: unknown, { userId, feed, search, reason }: { userId: string; feed: boolean; search: boolean; reason?: string | null }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'users.shadowban');
      const result = await toggleShadowBan(userId, feed, search, reason ?? null, adminId);
      return result.success === true;
    },

    adminUnshadowBan: async (_root: unknown, { userId }: { userId: string }, context: Context) => {
      const { userId: adminId } = await requirePermission(context, 'users.shadowban');
      const result = await toggleShadowBan(userId, false, false, null, adminId);
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
    stats:           (user: IUser) => ({ minutesSynced: user.stats?.minutesSynced ?? 0, wordsSynced: user.stats?.wordsSynced ?? 0, karaokeLines: user.stats?.karaokeLines ?? 0 }),
    streak:          (user: IUser) => ({ current: user.streak?.current ?? 0, longest: user.streak?.longest ?? 0, lastActiveDate: user.streak?.lastActiveDate ?? null }),
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

    showFollowers: async (user: IUser) => {
      const prefs = await getPreferences(user._id.toString());
      return prefs.showFollowers;
    },
    miniProfileBadgesEnabled: async (user: IUser) => {
      const prefs = await getPreferences(user._id.toString());
      return prefs.miniProfileBadgesEnabled;
    },
    miniProfileBadgeIds: async (user: IUser) => {
      const prefs = await getPreferences(user._id.toString());
      return prefs.miniProfileBadgesEnabled ? prefs.miniProfileBadgeIds : [];
    },
    onlineVisibility: async (user: IUser) => {
      const prefs = await getPreferences(user._id.toString());
      return prefs.onlineVisibility;
    },
  },
};
