import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import Project from '../../modules/projects/project.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import Settings from '../../modules/settings/settings.model.js';
import { Context } from './context.js';
import AccountNameHistory from '../../db/account-name-history.model.js';
import EmailHistory from '../../db/email-history.model.js';
import { sendVerification, resendVerification } from '../../modules/email-verification/email-verification.service.js';
import Follow from '../../db/follow.model.js';
import { upsertFollow } from '../../modules/notifications/notifications.service.js';
import { searchUsers as searchUsersService } from '../../modules/users/users.search.service.js';
import { writeActivity } from '../../modules/activity/activity.service.js';

export const userResolvers = {
  Query: {
    me: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) return null;
      const user = await User.findById(context.userId);
      return user?.toPublic();
    },

    publicProfile: async (_root: any, { accountName }: { accountName: string }, context: Context) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() }).lean();
      if (!user || (user as any).isDeleted || (user as any).ban?.active) return null;

      const [projects, projectCount] = await Promise.all([
        Project.find({ userId: user._id, public: true })
          .sort({ starCount: -1 })
          .limit(50)
          .lean(),
        Project.countDocuments({ userId: user._id, public: true }),
      ]);

      const totalStarsReceived = projects.reduce((sum, p) => sum + ((p as any).starCount ?? 0), 0);
      const totalForksReceived = projects.reduce((sum, p) => sum + ((p as any).forkCount ?? 0), 0);

      const isFollowedByMe = context.userId
        ? !!(await Follow.exists({ followerId: new mongoose.Types.ObjectId(context.userId), followingId: user._id }))
        : false;

      return {
        id: user._id.toString(),
        accountName: user.accountName,
        displayName: (user as any).displayName ?? null,
        avatarUrl: (user as any).avatarUrl ?? null,
        bio: (user as any).bio ?? null,
        isVerified: (user as any).isVerified ?? false,
        isAdmin: (user as any).role === 'admin',
        createdAt: (user as any).createdAt ? new Date((user as any).createdAt).toISOString() : null,
        projects,
        projectCount,
        totalStarsReceived,
        totalForksReceived,
        followerCount: (user as any).social?.followerCount ?? 0,
        followingCount: (user as any).social?.followingCount ?? 0,
        isFollowedByMe,
        showFollowers: (user as any).social?.showFollowers ?? true,
      };
    },

    searchUsers: async (_root: any, { query, limit = 10 }: { query: string; limit?: number }) => {
      return searchUsersService(query, limit);
    },

    followList: async (
      _root: any,
      { accountName, type, offset = 0 }: { accountName: string; type: 'FOLLOWERS' | 'FOLLOWING'; offset?: number },
      context: Context
    ) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() }).lean();
      if (!user || (user as any).isDeleted || (user as any).ban?.active) return { users: [], total: 0 };
      const isOwner = context.userId && context.userId === (user as any)._id.toString();
      if (!(user as any).social?.showFollowers && !isOwner) return { users: [], total: 0 };

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
          .lean();

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
          users: users.map(u => ({
            id: u._id.toString(),
            accountName: (u as any).accountName,
            displayName: (u as any).displayName ?? null,
            avatarUrl: (u as any).avatarUrl ?? null,
            isFollowedByMe: myFollowedSet.has(u._id.toString()),
          })),
          total: (user as any).social?.followerCount ?? 0,
        };
      } else {
        const follows = await Follow.find({ followerId: user._id })
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(LIMIT)
          .lean();
        const followingIds = follows.map(f => f.followingId);
        const users = await User.find({ _id: { $in: followingIds }, isDeleted: { $ne: true } })
          .select('accountName displayName avatarUrl')
          .lean();

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
          users: users.map(u => ({
            id: u._id.toString(),
            accountName: (u as any).accountName,
            displayName: (u as any).displayName ?? null,
            avatarUrl: (u as any).avatarUrl ?? null,
            isFollowedByMe: myFollowedSet.has(u._id.toString()),
          })),
          total: (user as any).social?.followingCount ?? 0,
        };
      }
    },
  },

  Mutation: {
    updateProfile: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const user = await User.findById(context.userId);
      if (!user) throw new Error('User not found');

      const { accountName, displayName, email, bio, avatarUrl } = input;

      if (accountName && accountName.toLowerCase().trim() !== user.accountName) {
        const COOLDOWN_DAYS = 7;
        if (user.lastAccountNameChangedAt) {
          const daysSince = (Date.now() - (user.lastAccountNameChangedAt as Date).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < COOLDOWN_DAYS) {
            const daysLeft = Math.ceil(COOLDOWN_DAYS - daysSince);
            throw Object.assign(new Error('accountName_change_cooldown'), { extensions: { code: 'accountName_change_cooldown', daysLeft, status: 429 } });
          }
        }
        const normalised = accountName.toLowerCase().trim();
        if (!/^[a-z0-9_-]{3,30}$/.test(normalised)) throw new Error('accountName_invalid');
        const existing = await User.findOne({ accountName: normalised });
        if (existing) throw new Error('Account name already taken');
        const previousAccountName = user.accountName;
        user.accountName = normalised;
        user.lastAccountNameChangedAt = new Date();
        AccountNameHistory.create({ userId: user._id, from: previousAccountName, to: normalised }).catch(() => {});
      }

      if (displayName !== undefined) {
        user.displayName = displayName ? displayName.trim().slice(0, 50) : null;
      }

      if (email && email.toLowerCase().trim() !== user.email && email.toLowerCase().trim() !== user.pendingEmail) {
        const normalised = email.toLowerCase().trim();
        const existing = await User.findOne({ $or: [{ email: normalised }, { pendingEmail: normalised }] });
        if (existing) throw new Error('Email already in use');
        user.pendingEmail = normalised;
        sendVerification(context.userId, normalised, 'email_change').catch(() => {});
      }

      if (bio !== undefined) {
        user.bio = bio.trim().slice(0, 160);
      }

      if (avatarUrl !== undefined) {
        user.avatarUrl = avatarUrl;
      }

      if (input.showFollowers !== undefined) {
        if (!(user as any).social) (user as any).social = {};
        (user as any).social.showFollowers = input.showFollowers;
      }

      await user.save();
      return user.toPublic();
    },

    sendVerificationEmail: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await resendVerification(context.userId);
      return true;
    },

    follow: async (_root: any, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');

      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean();
      if (!target || (target as any).isDeleted || (target as any).ban?.active) throw new Error('User not found');

      const targetId = (target as any)._id.toString();
      if (targetId === context.userId) throw new Error('Cannot follow yourself');

      try {
        await Follow.create({
          followerId: new mongoose.Types.ObjectId(context.userId),
          followingId: (target as any)._id,
        });
        await Promise.all([
          User.updateOne({ _id: (target as any)._id }, { $inc: { 'social.followerCount': 1 } }),
          User.updateOne({ _id: new mongoose.Types.ObjectId(context.userId) }, { $inc: { 'social.followingCount': 1 } }),
        ]);
        const follower = await User.findById(context.userId).lean();
        if (follower) {
          upsertFollow({
            ownerId: targetId,
            actorId: context.userId,
            actorAccountName: (follower as any).accountName,
            actorAvatarUrl: (follower as any).avatarUrl ?? null,
          }).catch(() => {});

          // fan-out follow activity — fire and forget
          writeActivity({
            actorId: context.userId,
            type: 'user_followed',
            projectId: '',
            projectTitle: (target as any).displayName || (target as any).accountName,
            coverImage: (target as any).avatarUrl ?? '',
            targetPath: `/${(target as any).accountName}`,
          }).catch(() => {});
        }
      } catch (err: any) {
        if (err.code === 11000) return true; // already following — idempotent
        throw err;
      }
      return true;
    },

    unfollow: async (_root: any, { accountName }: { accountName: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');

      const target = await User.findOne({ accountName: accountName.toLowerCase() }).lean();
      if (!target) return true;

      const result = await Follow.deleteOne({
        followerId: new mongoose.Types.ObjectId(context.userId),
        followingId: (target as any)._id,
      });

      if (result.deletedCount > 0) {
        await Promise.all([
          User.updateOne(
            { _id: (target as any)._id, 'social.followerCount': { $gt: 0 } },
            { $inc: { 'social.followerCount': -1 } }
          ),
          User.updateOne(
            { _id: new mongoose.Types.ObjectId(context.userId), 'social.followingCount': { $gt: 0 } },
            { $inc: { 'social.followingCount': -1 } }
          ),
        ]);
      }
      return true;
    },
  },

  User: {
    id: (user: any) => user._id?.toString() ?? user.id,
    createdAt: (user: any) => user.createdAt ? new Date(user.createdAt).toISOString() : null,
    projects: async (user: any) => Project.find({ userId: user._id ?? user.id }),
    uploads: async (user: any) => Upload.find({ userId: user._id ?? user.id }),
    settings: async (user: any) => Settings.findOne({ userId: user._id ?? user.id }),

    previousAccountNames: (user: any) =>
      AccountNameHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 }).then(
        docs => docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }))
      ),

    accountNameChangeCount: (user: any) =>
      AccountNameHistory.countDocuments({ userId: user._id ?? user.id }),

    emailHistory: async (user: any, _args: any, context: Context) => {
      const selfId = (user._id ?? user.id)?.toString();
      if (context.userId === selfId) {
        const docs = await EmailHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
        return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
      }
      if (context.userId) {
        const requester = await User.findById(context.userId).select('role').lean();
        if ((requester as any)?.role === 'admin') {
          const docs = await EmailHistory.find({ userId: user._id ?? user.id }).sort({ createdAt: -1 });
          return docs.map(d => ({ from: d.from, to: d.to, changedAt: d.createdAt?.toISOString() ?? '' }));
        }
      }
      return [];
    },
  },
};
