import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import Session from '../../db/session.model.js';
import BannedIp from './bannedIp.model.js';
import BannedDevice from './bannedDevice.model.js';
import UserDevice from '../auth/userDevice.model.js';
import Project from '../projects/project.model.js';
import Upload from '../uploads/upload.model.js';
import AdminLog from './adminLog.model.js';
import type { AdminLogEntry } from '../../types/index.js';
import { createOnce, notifyRoleChanged, notifyXpChanged, notifyUnban } from '../notifications/notifications.service.js';
import { sendBanEmail } from '../email/email.service.js';
import Settings from '../settings/settings.model.js';
import { getIO } from '../../socket/socket.manager.js';
import type { IUser } from '../../db/user.model.js';
import { PERMISSIONS, ROLE_PRESETS, ROLE_RANK, rankOf, isValidRole, type Permission, type Role } from '../../shared/permissions.js';
import geoip from 'geoip-lite';
import JobLog from '../../db/job-log.model.js';
import { getOnlineUserIds } from '../../socket/presence.js';
import RolePermissionsConfig from './rolePermissionsConfig.model.js';

// Staff-protection: resolve the acting admin's rank. A null actor (system call)
// is treated as top rank so internal automation isn't blocked.
async function actorRank(adminId: string | null): Promise<number> {
  if (!adminId) return Number.MAX_SAFE_INTEGER;
  const actor = await User.findById(adminId).select('role').lean<IUser>();
  return rankOf(actor?.role);
}

// Maximum XP an admin can grant or revoke in a single action. Adjust as needed.
export const MAX_XP_GRANT = 1_000_000;

export async function listUsers(query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { limit = 50, cursor = null, search = '', role = '', status = '' } = query as Record<string, string | number | null>;

  const filter: Record<string, unknown> = {};
  if (search) {
    // Anchored prefix regex allows MongoDB to use the username/email index
    const escapedSearch = (search as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { accountName: new RegExp(`^${escapedSearch}`, 'i') },
      { email: new RegExp(`^${escapedSearch}`, 'i') },
    ];
  }

  if (role) {
    const roles = (role as string).split(',').map(r => r.trim()).filter(Boolean);
    filter.role = roles.length === 1 ? roles[0] : { $in: roles };
  }
  if (status) {
    if (status === 'banned') filter['ban.active'] = true;
    if (status === 'active') filter['ban.active'] = { $ne: true };
    if (status === 'deleted') filter.isDeleted = true;
    if (status === 'verified') filter.isVerified = true;
    if (status === 'pending') filter['appeal.status'] = 'pending';
  }

  if (cursor) {
    filter._id = { $gt: new mongoose.Types.ObjectId(cursor as string) };
  }

  const usersRaw = await User.find(filter)
    .select('-passwordHash')
    .sort({ _id: 1 })
    .limit(Number(limit) + 1)
    .lean();

  const hasMore = usersRaw.length > Number(limit);
  const page = usersRaw.slice(0, Number(limit));
  const nextCursor = hasMore ? (page[page.length - 1]._id as mongoose.Types.ObjectId).toString() : null;
  const total = cursor ? null : await User.countDocuments(filter);

  if (page.length === 0) {
    return { users: [], nextCursor: null, hasMore: false, total };
  }

  const userIds = page.map((u: Record<string, unknown>) => u._id);

  const [projectCounts, uploadCounts, sessionData] = await Promise.all([
    Project.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]),
    Upload.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 }, storageUsed: { $sum: '$sizeBytes' } } },
    ]),
    Session.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $sort: { lastUsedAt: -1 } },
      { $group: { _id: '$userId', deviceId: { $first: '$deviceId' }, deviceName: { $first: '$deviceName' } } },
    ]),
  ]);

  const projectCountMap = new Map((projectCounts as { _id: string; count: number }[]).map(r => [r._id.toString(), r.count]));
  const uploadCountMap = new Map((uploadCounts as { _id: string; count: number; storageUsed: number }[]).map(r => [r._id.toString(), { count: r.count, storageUsed: r.storageUsed || 0 }]));
  const sessionMap = new Map((sessionData as { _id: mongoose.Types.ObjectId; deviceId: string; deviceName: string }[]).map(s => [s._id.toString(), { lastDeviceId: s.deviceId, lastDeviceName: s.deviceName }]));

  const users = page.map((u: Record<string, unknown>) => {
    const { _id, __v, ...rest } = u;
    return {
      ...rest,
      id: (_id as mongoose.Types.ObjectId).toString(),
      projectCount: projectCountMap.get((_id as mongoose.Types.ObjectId).toString()) ?? 0,
      uploadCount: uploadCountMap.get((_id as mongoose.Types.ObjectId).toString())?.count ?? 0,
      storageUsed: uploadCountMap.get((_id as mongoose.Types.ObjectId).toString())?.storageUsed ?? 0,
      country: rest.lastIp && rest.lastIp !== '127.0.0.1' && rest.lastIp !== '::1' ? geoip.lookup(rest.lastIp as string)?.country : null,
      isOnline: getOnlineUserIds().includes((_id as mongoose.Types.ObjectId).toString()),
      ...(sessionMap.get((_id as mongoose.Types.ObjectId).toString()) ?? {}),
    };
  });

  return { users, nextCursor, hasMore, total };
}

export async function getStats(): Promise<Record<string, unknown>> {
  const [
    totalUsers,
    bannedUsers,
    pendingAppeals,
    deletedUsers,
    totalProjects,
    totalUploads,
    totalStorageRaw,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ 'ban.active': true }),
    User.countDocuments({ 'appeal.status': 'pending' }),
    User.countDocuments({ isDeleted: true }),
    Project.countDocuments({}),
    Upload.countDocuments(),
    Upload.aggregate([{ $group: { _id: null, totalBytes: { $sum: '$sizeBytes' } } }]),
  ]);

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  const [
    activeUsers,
    newSignups24h,
    newSignups7d,
    newSignups30d,
    jobLogs24h
  ] = await Promise.all([
    User.countDocuments({ updatedAt: { $gte: yesterday } }),
    User.countDocuments({ createdAt: { $gte: yesterday } }),
    User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
    User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    JobLog.aggregate([
      { $match: { createdAt: { $gte: yesterday } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ])
  ]);
  
  const totalStorage = (totalStorageRaw as { totalBytes?: number }[])[0]?.totalBytes || 0;
  
  const jobHealth = {
    succeeded: (jobLogs24h as { _id: string, count: number }[]).find(j => j._id === 'succeeded')?.count || 0,
    failed: (jobLogs24h as { _id: string, count: number }[]).find(j => j._id === 'failed')?.count || 0,
  };

  return {
    totalUsers,
    bannedUsers,
    pendingAppeals,
    deletedUsers,
    activeUsers,
    newSignups24h,
    newSignups7d,
    newSignups30d,
    totalProjects,
    totalUploads: totalUploads as number,
    totalStorage,
    jobHealth,
  };
}

export async function toggleBan(userId: string, banStatus: boolean, reason: string | null = null, bannedUntil: string | null = null, banIp = false, banDevice = false, adminId: string | null = null, actorIp?: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  // Can't act on a peer or superior — only on someone strictly below your rank.
  if (rankOf(user.role) >= await actorRank(adminId)) {
    return { error: 'Cannot act on a user of equal or higher rank', status: 403 };
  }

  if (banStatus) {
    user.ban = { active: true, reason, until: bannedUntil ? new Date(bannedUntil) : null };

    if (banIp && user.lastIp) {
      const isLoopback = user.lastIp === '127.0.0.1' || user.lastIp === '::1' || user.lastIp === '::ffff:127.0.0.1';

      if (!isLoopback) {
        await BannedIp.findOneAndUpdate(
          { ip: user.lastIp },
          {
            ip: user.lastIp,
            reason: 'Associated with banned user: ' + user.accountName,
            userId: user._id,
            bannedBy: adminId,
          },
          { upsert: true }
        );
      }
    }

    if (banDevice) {
      const devices = await UserDevice.find({ userId: user._id }).select('deviceId').lean();
      for (const { deviceId } of devices) {
        await BannedDevice.findOneAndUpdate(
          { deviceId },
          {
            deviceId,
            reason: 'Associated with banned user: ' + user.accountName,
            userId: user._id,
            bannedBy: adminId,
          },
          { upsert: true }
        );
      }
    }
  } else {
    user.ban = { active: false, reason: null, until: null };
    user.appeal = { text: null, status: 'none', submittedAt: null, resolvedAt: new Date() };
    await BannedIp.deleteMany({ userId: user._id });
    await BannedDevice.deleteMany({ userId: user._id });
  }

  await user.save();

  if (!banStatus) {
    notifyUnban(userId).catch(() => {});
  }

  if (banStatus) {
    createOnce({ userId, type: 'ban', sticky: false, body: reason || null }).catch(() => {});
    const userEmail = user.email;
    if (userEmail) {
      Settings.findOne({ userId }).select('interface').lean().then((settings: { interface?: { defaultLanguage?: string; theme?: string } } | null) => {
        const prefs = { lang: settings?.interface?.defaultLanguage, theme: settings?.interface?.theme };
        return sendBanEmail(userEmail, reason || null, user.displayName || user.accountName, prefs);
      }).catch(() => {});
    }
    try { getIO().to(`user:${userId}`).emit('user:banned', { reason }); } catch { /* socket not ready */ }
  }

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      ip: actorIp,
      action: banStatus ? 'ban_user' : 'unban_user',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: banStatus ? 'Reason: ' + reason + (banIp ? ' (IP Banned)' : '') + (banDevice ? ' (Device Banned)' : '') : 'Appeal approved / Manual unban',
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function toggleShadowBan(
  userId: string,
  feed: boolean,
  search: boolean,
  reason: string | null = null,
  adminId: string | null = null,
  actorIp?: string
): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  if (rankOf(user.role) >= await actorRank(adminId)) {
    return { error: 'Cannot act on a user of equal or higher rank', status: 403 };
  }

  const active = feed || search;

  user.shadowBan = {
    feed,
    search,
    reason: active ? reason : null,
    appliedAt: active ? new Date() : null,
    appliedBy: active && adminId ? new mongoose.Types.ObjectId(adminId) : null,
  };

  await user.save();

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      ip: actorIp,
      action: active ? 'shadow_ban_user' : 'unshadow_ban_user',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: active
        ? `Feed: ${feed}, Search: ${search}. Reason: ${reason || 'none'}`
        : 'Shadow ban removed',
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function rejectAppeal(userId: string, adminId: string | null = null, actorIp?: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  user.appeal.status = 'rejected';
  user.appeal.submittedAt = null;
  user.appeal.resolvedAt = new Date();

  await user.save();

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      ip: actorIp,
      action: 'reject_appeal',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'Ban appeal rejected',
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function changeUserRole(userId: string, newRole: string, adminId: string | null = null, actorIp?: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (!isValidRole(newRole)) return { error: 'Invalid role', status: 400 };

  // Escalation guards (the heart of the system):
  //  - you can only modify a target strictly below your rank (blocks editing
  //    peers/superiors and, since self has equal rank, self-modification);
  //  - you can only assign a role strictly below your rank (blocks minting
  //    peers/superiors, e.g. a superadmin cannot create another superadmin —
  //    that is reserved for the grant-role CLI script, gated by DB access).
  const myRank = await actorRank(adminId);
  if (rankOf(user.role) >= myRank) {
    return { error: 'Cannot modify a user of equal or higher rank', status: 403 };
  }
  if (rankOf(newRole) >= myRank) {
    return { error: 'Cannot assign a role at or above your own', status: 403 };
  }

  const previousRole = user.role;
  user.role = newRole;
  // Role is descriptive; permissions are the authority — reseed them on change.
  // Uses the effective (DB-override-aware) preset, not the raw code constant,
  // so a superadmin's edited mod/admin defaults take effect immediately.
  const effectivePresets = await getEffectiveRolePresets();
  user.permissions = [...effectivePresets[newRole as Role]];
  await user.save();

  // Notify the affected user of the role change with before -> after.
  if (previousRole !== newRole) {
    notifyRoleChanged(user._id.toString(), previousRole, newRole).catch(() => {});
  }
  if (rankOf(previousRole) < ROLE_RANK.admin && rankOf(newRole) >= ROLE_RANK.admin) {
    import('../../modules/badges/badge.service.js')
      .then(({ triggerBadgeCheck }) => triggerBadgeCheck(user._id.toString(), 'role_change'))
      .catch(() => {});
  }

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      ip: actorIp,
      action: 'change_role',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'New role: ' + newRole,
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function deleteUser(userId: string, adminId: string | null = null, actorIp?: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (rankOf(user.role) >= await actorRank(adminId)) {
    return { error: 'Cannot act on a user of equal or higher rank', status: 403 };
  }

  user.deletedAt = new Date();
  user.isDeleted = true;
  user.ban.active = false;
  user.ban.reason = null;
  user.ban.until = null;
  user.appeal.text = null;
  user.appeal.status = 'none';

  await user.save();

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      ip: actorIp,
      action: 'delete_user',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'Soft deletion',
    });
  }

  return { success: true };
}

export async function reactivateUser(userId: string, adminId: string | null = null, actorIp?: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  user.isDeleted = false;
  user.deletedAt = null;

  await user.save();

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      ip: actorIp,
      action: 'reactivate_user',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'Account reactivated',
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function listBannedIps(): Promise<Record<string, unknown>[]> {
  const ips = await BannedIp.find().sort({ createdAt: -1 }).lean();
  return ips.map((ip: Record<string, unknown>) => {
    const { _id, __v, ...rest } = ip;
    return { ...rest, id: (_id as Record<string, unknown>).toString() };
  });
}

export async function blockIp(ip: string, reason: string, adminId: string, actorIp?: string): Promise<Record<string, unknown>> {
  const existing = await BannedIp.findOne({ ip });
  if (existing) return { error: 'IP already banned', status: 409 };

  const bannedIp = await BannedIp.create({
    ip,
    reason,
    bannedBy: adminId,
  });
  await logAdminAction({ adminId, action: 'block_ip', targetName: ip, details: reason || null, ip: actorIp });
  return { success: true, bannedIp };
}

export async function unblockIp(ipId: string, adminId: string, actorIp?: string): Promise<Record<string, unknown>> {
  const doc = await BannedIp.findByIdAndDelete(ipId).lean<{ ip?: string }>();
  await logAdminAction({ adminId, action: 'unblock_ip', targetName: doc?.ip ?? null, ip: actorIp });
  return { success: true };
}

export async function listBannedDevices(): Promise<Record<string, unknown>[]> {
  const devices = await BannedDevice.find().sort({ createdAt: -1 }).lean();
  return devices.map((d: Record<string, unknown>) => {
    const { _id, __v, ...rest } = d;
    return { ...rest, id: (_id as Record<string, unknown>).toString() };
  });
}

export async function blockDevice(deviceId: string, reason: string, adminId: string, actorIp?: string): Promise<Record<string, unknown>> {
  const existing = await BannedDevice.findOne({ deviceId });
  if (existing) return { error: 'Device already banned', status: 409 };

  const bannedDevice = await BannedDevice.create({
    deviceId,
    reason,
    bannedBy: adminId,
  });
  await logAdminAction({ adminId, action: 'block_device', targetName: deviceId, details: reason || null, ip: actorIp });
  return { success: true, bannedDevice };
}

export async function unblockDevice(deviceIdId: string, adminId: string, actorIp?: string): Promise<Record<string, unknown>> {
  const doc = await BannedDevice.findByIdAndDelete(deviceIdId).lean<{ deviceId?: string }>();
  await logAdminAction({ adminId, action: 'unblock_device', targetName: doc?.deviceId ?? null, ip: actorIp });
  return { success: true };
}

export async function listAdminLogs(query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { page = 1, limit = 100 } = query as Record<string, number>;
  const logs = await AdminLog.find()
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .populate('adminId', 'accountName email')
    .lean();
  return { logs, page, limit };
}

export type XPTarget = 'all' | 'user' | 'users';

export async function adjustXP(
  action: 'grant' | 'revoke',
  amount: number,
  target: XPTarget,
  adminId: string,
  userId?: string,
  userIds?: string[],
  actorIp?: string
): Promise<{ affected: number }> {
  const { computeLevel } = await import('../../modules/badges/badge.service.js');
  // Clamp the per-action grant/revoke magnitude so a single admin action can't
  // apply an arbitrarily large XP swing.
  const capped = Math.min(Math.abs(amount), MAX_XP_GRANT);
  const delta = action === 'grant' ? capped : -capped;
  let affected = 0;

  // Manual admin grants/revokes are applied directly to progression.xp and
  // must NOT be followed by recomputeXP() — that function derives xp purely
  // from stats/badges and would silently overwrite (discard) this delta.
  // `notify` is set for targeted grants (user/users) so each affected user gets
  // a real-time before -> after notification. Skipped for target 'all' to avoid
  // a write storm of one notification per user across the whole user base.
  const applyDelta = async (ids: string[], notify = false) => {
    if (!ids.length) return;
    await User.updateMany({ _id: { $in: ids } }, { $inc: { 'progression.xp': delta } });
    const updated = await User.find({ _id: { $in: ids } }).select('_id progression.xp').lean<{ _id: mongoose.Types.ObjectId; progression?: { xp?: number } }[]>();
    await Promise.all(updated.map((u) => {
      // Post-$inc value; recover the pre-action value to report before -> after.
      const rawAfter = u.progression?.xp ?? 0;
      const before = rawAfter - delta;
      const after = Math.max(0, rawAfter);
      if (notify) notifyXpChanged(u._id.toString(), delta, before, after).catch(() => {});
      return User.updateOne({ _id: u._id }, { 'progression.xp': after, 'progression.level': computeLevel(after) });
    }));
  };

  if (target === 'all') {
    const users = await User.find({ isDeleted: { $ne: true } }).select('_id').lean();
    const ids = users.map((u) => (u._id as { toString(): string }).toString());
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      await applyDelta(ids.slice(i, i + BATCH));
    }
    affected = ids.length;
  } else if (target === 'user' && userId) {
    await applyDelta([userId], true);
    affected = 1;
  } else if (target === 'users' && userIds?.length) {
    // Resolve each entry: if it looks like a valid ObjectId use it directly,
    // otherwise treat it as an accountName and look up the corresponding _id.
    const resolvedIds: string[] = [];
    for (const entry of userIds) {
      if (mongoose.Types.ObjectId.isValid(entry) && entry.length === 24) {
        resolvedIds.push(entry);
      } else {
        const found = await User.findOne({ accountName: entry }).select('_id').lean<{ _id: mongoose.Types.ObjectId }>();
        if (found) resolvedIds.push(found._id.toString());
      }
    }
    await applyDelta(resolvedIds, true);
    affected = resolvedIds.length;
  }

  const admin = await User.findById(adminId).select('accountName').lean<{ accountName?: string }>();
  await logAdminAction({
    adminId,
    adminName: admin?.accountName || 'System',
    action: `xp_${action}`,
    details: `${action === 'grant' ? '+' : '-'}${amount} XP → ${target === 'all' ? 'all users' : target === 'user' ? `user ${userId}` : `${userIds?.length} users`}`,
    ip: actorIp,
  });

  return { affected };
}

/**
 * Ensures every user's permissions include at least the permissions their role
 * currently prescribes. Uses $addToSet so custom per-user overrides are never
 * removed. Called on server startup to pick up newly-added permissions.
 * Uses the effective (DB-override-aware) presets so admin-edited role
 * defaults are also backfilled onto existing users, not just the code ones.
 */
export async function syncRolePermissions(): Promise<void> {
  const effectivePresets = await getEffectiveRolePresets();
  for (const [role, presetPerms] of Object.entries(effectivePresets)) {
    if (presetPerms.length === 0) continue;
    await User.updateMany(
      { role, isDeleted: { $ne: true } },
      { $addToSet: { permissions: { $each: presetPerms } } }
    );
  }
}

// ---------------------------------------------------------------------------
// Role permission presets: superadmin-editable overrides of ROLE_PRESETS.
// ---------------------------------------------------------------------------

// Roles whose default permission set can be edited via the "Manage
// permissions" UI. 'user' is always [] by design; 'superadmin' always holds
// every permission (its ROLE_PRESETS value is `[...PERMISSIONS]`) — allowing
// it to be edited here would let the UI shrink the one role that is supposed
// to always have full access, so it's intentionally excluded.
const EDITABLE_ROLES: readonly Role[] = ['mod', 'admin'];

/**
 * Resolves the currently-effective permission preset for every role: the
 * DB-stored override when one exists for that role, otherwise the
 * code-defined ROLE_PRESETS default. The code constants are never mutated —
 * they remain the seed value and the fallback when no override is stored.
 */
export async function getEffectiveRolePresets(): Promise<Record<Role, Permission[]>> {
  const config = await RolePermissionsConfig.findById('singleton').lean<{ mod?: string[]; admin?: string[] } | null>();
  return {
    user: [...ROLE_PRESETS.user] as Permission[],
    mod: (config?.mod ?? ROLE_PRESETS.mod) as Permission[],
    admin: (config?.admin ?? ROLE_PRESETS.admin) as Permission[],
    superadmin: [...ROLE_PRESETS.superadmin] as Permission[],
  };
}

/** Catalog for the "Manage permissions" page: every known permission + the effective preset per role. */
export async function getPermissionsCatalog(): Promise<{ permissions: readonly Permission[]; presets: Record<Role, Permission[]> }> {
  const presets = await getEffectiveRolePresets();
  return { permissions: PERMISSIONS, presets };
}

/**
 * Overwrites the default permission set assigned to `role` on future
 * role-assignment/sync. Superadmin-only (enforced by the requireSuperadmin
 * route hook; re-checked here since a bug here is a privilege-escalation
 * hole). Every permission id is validated against the PERMISSIONS whitelist.
 */
export async function updateRolePreset(
  role: string,
  permissions: string[],
  adminId: string,
  actorIp?: string
): Promise<Record<string, unknown>> {
  if (!EDITABLE_ROLES.includes(role as Role)) {
    return { error: 'This role\'s permission set cannot be edited', status: 400 };
  }
  const invalid = permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
  if (invalid.length > 0) {
    return { error: `Unknown permission(s): ${invalid.join(', ')}`, status: 400 };
  }
  // Re-check literal superadmin status server-side (never trust the route
  // hook alone — permission grants are the escalation surface this module
  // guards). rankOf() is an extra belt-and-suspenders check on top of the
  // exact role-string comparison.
  const actor = await User.findById(adminId).select('role accountName').lean<IUser & { accountName?: string }>();
  if (!actor || actor.role !== 'superadmin' || rankOf(actor.role) !== ROLE_RANK.superadmin) {
    return { error: 'Forbidden', status: 403 };
  }

  const before = await getEffectiveRolePresets();
  const deduped = Array.from(new Set(permissions)) as Permission[];

  await RolePermissionsConfig.findByIdAndUpdate(
    'singleton',
    { $set: { [role]: deduped } },
    { upsert: true }
  );

  await logAdminAction({
    adminId,
    adminName: actor.accountName || 'System',
    ip: actorIp,
    action: 'update_role_preset',
    targetName: role,
    details: `Before: [${before[role as Role].join(', ')}] -> After: [${deduped.join(', ')}]`,
  });

  return { success: true, presets: await getEffectiveRolePresets() };
}

/**
 * Grants/revokes individual permissions for one staff member, overriding
 * their role default. Superadmin-only. Never touches `role` or rank — only
 * the `permissions` array — so this surface cannot be used to mint another
 * superadmin or change anyone's staff-protection rank.
 */
export async function updateUserPermissions(
  userId: string,
  permissions: string[],
  adminId: string,
  actorIp?: string
): Promise<Record<string, unknown>> {
  const invalid = permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
  if (invalid.length > 0) {
    return { error: `Unknown permission(s): ${invalid.join(', ')}`, status: 400 };
  }

  const actor = await User.findById(adminId).select('role accountName').lean<IUser & { accountName?: string }>();
  if (!actor || actor.role !== 'superadmin' || rankOf(actor.role) !== ROLE_RANK.superadmin) {
    return { error: 'Forbidden', status: 403 };
  }

  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  // Same staff-protection invariant as every other admin mutation: can only
  // act on a target strictly below the actor's rank. Since only rank 3
  // (superadmin) can reach this function and rank 3 is reserved for the
  // SUPERADMIN_EMAIL-based grant (never assignable here), this also means a
  // superadmin can never edit another superadmin's permissions through this
  // endpoint, and can never self-edit (self has equal rank).
  if (rankOf(user.role) >= ROLE_RANK.superadmin) {
    return { error: 'Cannot act on a user of equal or higher rank', status: 403 };
  }

  const before = [...(user.permissions ?? [])];
  const deduped = Array.from(new Set(permissions));
  user.permissions = deduped;
  await user.save();

  await logAdminAction({
    adminId,
    adminName: actor.accountName || 'System',
    ip: actorIp,
    action: 'update_user_permissions',
    targetId: user._id.toString(),
    targetName: user.accountName,
    details: `Before: [${before.join(', ')}] -> After: [${deduped.join(', ')}]`,
  });

  return { success: true, user: user.toPublic() };
}

export async function logAdminAction({ adminId, adminName, action, targetId, targetName, details, ip }: {
  adminId: string;
  adminName?: string;
  action: string;
  targetId?: string | null;
  targetName?: string | null;
  details?: string | null;
  ip?: string | null;
}): Promise<void> {
  // Resolve the admin's display name if the caller didn't supply it, so call
  // sites (especially GraphQL resolvers) can just pass adminId.
  let name = adminName;
  if (!name) {
    const admin = await User.findById(adminId).select('accountName').lean<{ accountName?: string }>();
    name = admin?.accountName || 'System';
  }
  // targetId is an ObjectId ref — only set it for real user targets. Non-user
  // targets (IPs, badge/level ids) live in targetName/details instead.
  const targetUserId = targetId && mongoose.Types.ObjectId.isValid(targetId) ? targetId : null;
  await AdminLog.create({
    adminId,
    adminName: name,
    action,
    targetId: targetUserId,
    targetName: targetName ?? null,
    details: details ?? null,
    ip: ip ?? null,
  });
}