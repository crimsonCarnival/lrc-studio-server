import User from '../../db/user.model.js';
import type { IUser, IUserBadge } from '../../db/user.model.js';
import { Context } from './context.js';
import { requirePermission, requireStaff } from './auth-guards.js';
import { logAdminAction } from '../../modules/admin/admin.service.js';
import { findUserByAccountName } from '../../modules/users/account-name.service.js';
import { isHiddenByBlock } from '../../modules/blocks/block.service.js';
import {
  updateShowcase as updateShowcaseService,
  getBadgeRarity,
  getShowcaseSlots,
  listBadgeDefsWithHolders,
  listPublicBadgeDefs,
} from '../../modules/badges/badge.service.js';
import BadgeDefinition from '../../modules/badges/badge-definition.model.js';
import type { IBadgeDefinition } from '../../modules/badges/badge-definition.model.js';

export interface BadgeInput {
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

/**
 * Badge definitions, the per-user showcase, and the staff badge-management mutations.
 *
 * These used to live in user.resolvers.ts, which left `badges` — a module with its own
 * model and a 950-line service — without a resolver file of its own, unlike every other
 * domain here. The grant/revoke/create/update/delete/scan mutations keep their dynamic
 * import of badge.service, which is load-bearing rather than stylistic.
 */
export const badgeResolvers = {
  Query: {
    badgeDefinitions: async (_root: unknown, _args: unknown, context: Context) => {
      // Staff-wide read: proposers without badges.manage need the list to propose edits.
      await requireStaff(context);
      return listBadgeDefsWithHolders();
    },

    // Display fields only (no condition/XP internals) — open to every viewer.
    publicBadgeDefinitions: () => listPublicBadgeDefs(),

    userShowcase: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      const user = await findUserByAccountName<IUser>(accountName, 'badges showcasedBadges');
      if (!user || await isHiddenByBlock(context.userId, user._id)) return [];

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
  },

  Mutation: {
    updateShowcase: async (_root: unknown, { badgeIds, showcasePublic }: { badgeIds: string[]; showcasePublic?: boolean }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await updateShowcaseService(context.userId, badgeIds, showcasePublic);
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
  },
};
