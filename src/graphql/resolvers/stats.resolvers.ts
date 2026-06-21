import { getUserContentStats } from '../../modules/stats/content-stats.service.js';
import {
  getAllLevels,
  createLevel,
  updateLevel,
  deleteLevel,
} from '../../modules/stats/addiction-level.service.js';
import { Context } from './context.js';
import { requirePermission } from './auth-guards.js';
import { logAdminAction } from '../../modules/admin/admin.service.js';

export const statsResolvers = {
  Query: {
    userContentStats: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return getUserContentStats(context.userId);
    },

    adminAddictionLevels: async (_root: unknown, _args: unknown, context: Context) => {
      await requirePermission(context, 'levels.manage');
      return getAllLevels();
    },
  },

  Mutation: {
    adminCreateAddictionLevel: async (
      _root: unknown,
      { input }: { input: Parameters<typeof createLevel>[0] },
      context: Context
    ) => {
      const { userId: adminId } = await requirePermission(context, 'levels.manage');
      const level = await createLevel(input);
      logAdminAction({ adminId, action: 'create_level', targetName: level?.id ?? null, ip: context.ip }).catch(() => {});
      return level;
    },

    adminUpdateAddictionLevel: async (
      _root: unknown,
      { id, input }: { id: string; input: Parameters<typeof updateLevel>[1] },
      context: Context
    ) => {
      const { userId: adminId } = await requirePermission(context, 'levels.manage');
      const level = await updateLevel(id, input);
      if (!level) throw new Error('Level not found');
      logAdminAction({ adminId, action: 'update_level', targetName: id, ip: context.ip }).catch(() => {});
      return level;
    },

    adminDeleteAddictionLevel: async (
      _root: unknown,
      { id }: { id: string },
      context: Context
    ) => {
      const { userId: adminId } = await requirePermission(context, 'levels.manage');
      const result = await deleteLevel(id);
      logAdminAction({ adminId, action: 'delete_level', targetName: id, ip: context.ip }).catch(() => {});
      return result;
    },
  },
};
