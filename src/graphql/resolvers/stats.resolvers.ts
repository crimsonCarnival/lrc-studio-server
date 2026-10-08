import { getUserContentStats } from '../../modules/stats/content-stats.service.js';
import {
  getAllLevels,
  createLevel,
  updateLevel,
  deleteLevel,
} from '../../modules/stats/addiction-level.service.js';
import { Context } from './context.js';
import { requirePermission, requireStaff } from './auth-guards.js';
import { logAdminAction } from '../../modules/admin/admin.service.js';
import { xpRequiredForLevel, getShowcaseSlots } from '../../modules/badges/badge.service.js';

const XP_CURVE_DEFAULT_MAX_LEVEL = 50;
const XP_CURVE_MIN_LEVEL = 1;
const XP_CURVE_MAX_LEVEL = 200;

export const statsResolvers = {
  Query: {
    userContentStats: async (_root: unknown, _args: unknown, context: Context) => {
      if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return getUserContentStats(context.userId);
    },

    adminAddictionLevels: async (_root: unknown, _args: unknown, context: Context) => {
      // Staff-wide read: proposers without levels.manage need the list to propose edits.
      await requireStaff(context);
      return getAllLevels();
    },

    // Admin dashboard reference table for the XP economy. Derived from the real
    // server formula (xpRequiredForLevel is the inverse of computeLevel), so the
    // client never has to restate the curve and cannot drift from it.
    xpLevelCurve: async (
      _root: unknown,
      { maxLevel }: { maxLevel?: number | null },
      context: Context
    ): Promise<{ level: number; xpRequired: number; xpToNext: number; showcaseSlots: number }[]> => {
      // Staff-wide read, matching adminAddictionLevels: reference data only, no
      // per-user information, but not something to expose to every visitor.
      await requireStaff(context);

      const requested = Number.isFinite(maxLevel) ? Math.floor(maxLevel as number) : XP_CURVE_DEFAULT_MAX_LEVEL;
      const cap = Math.min(Math.max(requested, XP_CURVE_MIN_LEVEL), XP_CURVE_MAX_LEVEL);

      const rows = [];
      for (let level = 1; level <= cap; level++) {
        const xpRequired = xpRequiredForLevel(level);
        rows.push({
          level,
          xpRequired,
          xpToNext: xpRequiredForLevel(level + 1) - xpRequired,
          showcaseSlots: getShowcaseSlots(level),
        });
      }
      return rows;
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
