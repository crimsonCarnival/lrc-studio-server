import User from '../../db/user.model.js';
import { getFeed } from '../../modules/activity/activity.service.js';
import { Context } from './context.js';

export interface ActivityDoc {
  _id?: { toString(): string };
  id?: string;
  type: string;
  createdAt?: Date | string;
  actorId?: { toString(): string } | string;
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
  },

  Activity: {
    id: (a: ActivityDoc) => a._id?.toString() ?? a.id,
    // Convert snake_case DB enum to SCREAMING_SNAKE_CASE GQL enum
    type: (a: ActivityDoc) => a.type.toUpperCase(),
    createdAt: (a: ActivityDoc) => (a.createdAt ? new Date(a.createdAt).toISOString() : null),
    actor: async (a: ActivityDoc) => {
      const user = await User.findById(a.actorId)
        .select('accountName displayName avatarUrl')
        .lean<LeanUser>();
      // User may have been deleted after the activity was written — return a
      // sentinel rather than null so the non-nullable `actor: FollowUser!`
      // field doesn't null-bubble the entire Activity object.
      if (!user) return {
        id: a.actorId?.toString() ?? 'deleted',
        accountName: '[deleted]',
        displayName: null,
        avatarUrl: null,
      };
      return {
        id: user._id.toString(),
        accountName: user.accountName,
        displayName: user.displayName ?? null,
        avatarUrl:   user.avatarUrl ?? null,
      };
    },
  },
};
