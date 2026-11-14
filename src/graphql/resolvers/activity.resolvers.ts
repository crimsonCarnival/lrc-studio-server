import mongoose from 'mongoose';
import User from '../../modules/users/user.model.js';
import Follow from '../../modules/users/follow.model.js';
import { getFeed, getUserActivity, getUserActivityHeatmap } from '../../modules/activity/activity.service.js';
import { Context } from './context.js';

export interface ActivityDoc {
  _id?: { toString(): string };
  id?: string;
  type: string;
  createdAt?: Date | string;
  actorId?: { toString(): string } | string;
  coverImage?: string;
  targetPath?: string;
}

interface LeanUser {
  _id: { toString(): string };
  accountName?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export const activityResolvers = {
  Query: {
    feed: async (
      _root: unknown,
      { offset = 0, limit = 20 }: { offset?: number; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
      return getFeed(context.userId, offset, Math.min(limit, 50));
    },

    userActivity: async (
      _root: unknown,
      { offset = 0, limit = 50 }: { offset?: number; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
      return getUserActivity(context.userId, offset, Math.min(limit, 100));
    },

    userActivityHeatmap: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) {
        const err = Object.assign(new Error('Unauthorized'), { status: 401 });
        throw err;
      }
      return getUserActivityHeatmap(context.userId);
    },
  },

  Activity: {
    id: (a: ActivityDoc) => a._id?.toString() ?? a.id,
    // Convert snake_case DB enum to SCREAMING_SNAKE_CASE GQL enum
    type: (a: ActivityDoc) => a.type.toUpperCase(),
    createdAt: (a: ActivityDoc) => (a.createdAt ? new Date(a.createdAt).toISOString() : null),
    // A follow's cover is the followed user's avatar. The stored copy dies when
    // they change it (the old file is deleted on replace), so read the current
    // one. Account names in anyone's history stay reserved, so this lookup finds
    // the same user or nobody; nobody (renamed) falls back to the stored copy.
    coverImage: async (a: ActivityDoc) => {
      if (a.type !== 'user_followed' || !a.targetPath) return a.coverImage ?? null;
      const target = await User.findOne({ accountName: a.targetPath.replace(/^\//, '') })
        .select('avatarUrl')
        .lean<{ avatarUrl?: string | null }>();
      return target ? target.avatarUrl ?? null : a.coverImage ?? null;
    },
    actor: async (a: ActivityDoc, _args: unknown, context: Context) => {
      const user = await User.findById(a.actorId)
        .select('accountName displayName avatarUrl role')
        .lean<LeanUser & { role?: string | null }>();
      // User may have been deleted after the activity was written — return a
      // sentinel rather than null so the non-nullable `actor: FollowUser!`
      // field doesn't null-bubble the entire Activity object.
      if (!user) return {
        id: a.actorId?.toString() ?? 'deleted',
        accountName: '[deleted]',
        displayName: null,
        avatarUrl: null,
        staffRole: null,
        isFollowedByMe: false,
      };
      const id = user._id.toString();
      // Lets a "followed you" card offer "Follow back" only to someone not following yet.
      const isFollowedByMe = !!context.userId && context.userId !== id
        && !!(await Follow.exists({ followerId: new mongoose.Types.ObjectId(context.userId), followingId: new mongoose.Types.ObjectId(id) }));
      return {
        id,
        accountName: user.accountName,
        displayName: user.displayName ?? null,
        avatarUrl:   user.avatarUrl ?? null,
        staffRole: user.role && user.role !== 'user' ? user.role : null,
        isFollowedByMe,
      };
    },
  },
};
