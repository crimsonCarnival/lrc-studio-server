import User from '../../db/user.model.js';
import { getFeed } from '../../modules/activity/activity.service.js';
import { Context } from './context.js';

export const activityResolvers = {
  Query: {
    feed: async (
      _root: any,
      { offset = 0, limit = 20 }: { offset?: number; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        const err = new Error('Unauthorized') as any;
        err.status = 401;
        throw err;
      }
      return getFeed(context.userId, offset, Math.min(limit, 50));
    },
  },

  Activity: {
    id: (a: any) => a._id?.toString() ?? a.id,
    // Convert snake_case DB enum to SCREAMING_SNAKE_CASE GQL enum
    type: (a: any) => (a.type as string).toUpperCase() as any,
    createdAt: (a: any) => (a.createdAt ? new Date(a.createdAt).toISOString() : null),
    actor: async (a: any) => {
      const user = await User.findById(a.actorId)
        .select('accountName displayName avatarUrl')
        .lean();
      if (!user) return null;
      return {
        id: (user as any)._id.toString(),
        accountName: (user as any).accountName,
        displayName: (user as any).displayName ?? null,
        avatarUrl:   (user as any).avatarUrl ?? null,
      };
    },
  },
};
