import { getUserContentStats } from '../../modules/stats/content-stats.service.js';
import {
  getAllLevels,
  createLevel,
  updateLevel,
  deleteLevel,
} from '../../modules/stats/addiction-level.service.js';
import { Context } from './context.js';
import { requireAdmin } from './auth-guards.js';

export const statsResolvers = {
  Query: {
    userContentStats: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return getUserContentStats(context.userId);
    },

    adminAddictionLevels: async (_root: unknown, _args: unknown, context: Context) => {
      await requireAdmin(context);
      return getAllLevels();
    },
  },

  Mutation: {
    adminCreateAddictionLevel: async (
      _root: unknown,
      { input }: { input: Parameters<typeof createLevel>[0] },
      context: Context
    ) => {
      await requireAdmin(context);
      return createLevel(input);
    },

    adminUpdateAddictionLevel: async (
      _root: unknown,
      { id, input }: { id: string; input: Parameters<typeof updateLevel>[1] },
      context: Context
    ) => {
      await requireAdmin(context);
      const level = await updateLevel(id, input);
      if (!level) throw new Error('Level not found');
      return level;
    },

    adminDeleteAddictionLevel: async (
      _root: unknown,
      { id }: { id: string },
      context: Context
    ) => {
      await requireAdmin(context);
      return deleteLevel(id);
    },
  },
};
