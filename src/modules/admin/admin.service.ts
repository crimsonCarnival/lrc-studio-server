import mongoose from 'mongoose';
import User from '../../db/user.model.js';
import BannedIp from './bannedIp.model.js';
import BannedDevice from './bannedDevice.model.js';
import UserDevice from '../auth/userDevice.model.js';
import Project from '../projects/project.model.js';
import Upload from '../uploads/upload.model.js';
import AdminLog from './adminLog.model.js';
import type { AdminLogEntry } from '../../types/index.js';
import { createOnce, notifyAdminGranted } from '../notifications/notifications.service.js';
import { sendBanEmail } from '../email/email.service.js';
import { getIO } from '../../socket/socket.manager.js';

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

  if (role) filter.role = role;
  if (status) {
    if (status === 'banned') filter['ban.active'] = true;
    if (status === 'active') filter['ban.active'] = { $ne: true };
    if (status === 'deleted') filter.isDeleted = true;
    if (status === 'verified') filter.isVerified = true;
    if (status === 'pending') filter['appeal.status'] = 'pending';
    if (status === 'premium') {
      (filter as Record<string, unknown>)['spotify.isPremium'] = true;
    }
  }

  if (cursor) {
    filter._id = { $gt: new mongoose.Types.ObjectId(cursor as string) };
  }

  const usersRaw = await User.find(filter)
    .select('-passwordHash -spotify.accessToken -spotify.refreshToken')
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

  const [projectCounts, uploadCounts] = await Promise.all([
    Project.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]),
    Upload.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]),
  ]);

  const projectCountMap = new Map((projectCounts as { _id: string; count: number }[]).map(r => [r._id.toString(), r.count]));
  const uploadCountMap = new Map((uploadCounts as { _id: string; count: number }[]).map(r => [r._id.toString(), r.count]));

  const users = page.map((u: Record<string, unknown>) => ({
    ...u,
    id: (u._id as mongoose.Types.ObjectId).toString(),
    projectCount: projectCountMap.get((u._id as mongoose.Types.ObjectId).toString()) ?? 0,
    uploadCount: uploadCountMap.get((u._id as mongoose.Types.ObjectId).toString()) ?? 0,
  }));

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
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ 'ban.active': true }),
    User.countDocuments({ 'appeal.status': 'pending' }),
    User.countDocuments({ isDeleted: true }),
    Project.countDocuments({}),
    Upload.countDocuments(),
  ]);

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeUsers = await User.countDocuments({ updatedAt: { $gte: yesterday } });

  return {
    totalUsers,
    bannedUsers,
    pendingAppeals,
    deletedUsers,
    activeUsers,
    totalProjects,
    totalUploads,
  };
}

export async function toggleBan(userId: string, banStatus: boolean, reason: string | null = null, bannedUntil: string | null = null, banIp = false, banDevice = false, adminId: string | null = null): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (user.role === 'admin') return { error: 'Cannot ban an admin', status: 403 };

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
    user.showUnbanMessage = true;
  }

  await user.save();

  if (banStatus) {
    createOnce({ userId, type: 'ban', sticky: false, body: reason || null }).catch(() => {});
    if (user.email) {
      sendBanEmail(user.email, reason || null, (user as any).displayName || user.accountName).catch(() => {});
    }
    try { getIO().to(`user:${userId}`).emit('user:banned', { reason }); } catch { /* socket not ready */ }
  }

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      action: banStatus ? 'ban_user' : 'unban_user',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: banStatus ? 'Reason: ' + reason + (banIp ? ' (IP Banned)' : '') + (banDevice ? ' (Device Banned)' : '') : 'Appeal approved / Manual unban',
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function rejectAppeal(userId: string, adminId: string | null = null): Promise<Record<string, unknown>> {
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
      action: 'reject_appeal',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'Ban appeal rejected',
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function changeUserRole(userId: string, newRole: string, adminId: string | null = null): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (!['user', 'admin'].includes(newRole)) return { error: 'Invalid role', status: 400 };

  const previousRole = user.role;
  user.role = newRole as 'user' | 'admin';
  await user.save();

  if (previousRole !== 'admin' && newRole === 'admin') {
    notifyAdminGranted(user._id.toString()).catch(() => {});
    import('../../modules/badges/badge.service.js')
      .then(({ triggerBadgeCheck }) => triggerBadgeCheck(user._id.toString(), 'role_change'))
      .catch(() => {});
  }

  if (adminId) {
    const admin = await User.findById(adminId);
    await logAdminAction({
      adminId,
      adminName: admin?.accountName || 'System',
      action: 'change_role',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'New role: ' + newRole,
    });
  }

  return { success: true, user: user.toPublic() };
}

export async function deleteUser(userId: string, adminId: string | null = null): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };
  if (user.role === 'admin') return { error: 'Cannot delete an admin', status: 403 };

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
      action: 'delete_user',
      targetId: user._id.toString(),
      targetName: user.accountName,
      details: 'Soft deletion',
    });
  }

  return { success: true };
}

export async function reactivateUser(userId: string, adminId: string | null = null): Promise<Record<string, unknown>> {
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
  return ips.map((ip: Record<string, unknown>) => ({ ...ip, id: (ip._id as Record<string, unknown>).toString() }));
}

export async function blockIp(ip: string, reason: string, adminId: string): Promise<Record<string, unknown>> {
  const existing = await BannedIp.findOne({ ip });
  if (existing) return { error: 'IP already banned', status: 409 };

  const bannedIp = await BannedIp.create({
    ip,
    reason,
    bannedBy: adminId,
  });
  return { success: true, bannedIp };
}

export async function unblockIp(ipId: string): Promise<Record<string, unknown>> {
  await BannedIp.findByIdAndDelete(ipId);
  return { success: true };
}

export async function listBannedDevices(): Promise<Record<string, unknown>[]> {
  const devices = await BannedDevice.find().sort({ createdAt: -1 }).lean();
  return devices.map((d: Record<string, unknown>) => ({ ...d, id: (d._id as Record<string, unknown>).toString() }));
}

export async function blockDevice(deviceId: string, reason: string, adminId: string): Promise<Record<string, unknown>> {
  const existing = await BannedDevice.findOne({ deviceId });
  if (existing) return { error: 'Device already banned', status: 409 };

  const bannedDevice = await BannedDevice.create({
    deviceId,
    reason,
    bannedBy: adminId,
  });
  return { success: true, bannedDevice };
}

export async function unblockDevice(deviceIdId: string): Promise<Record<string, unknown>> {
  await BannedDevice.findByIdAndDelete(deviceIdId);
  return { success: true };
}

export async function listAdminLogs(query: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { page = 1, limit = 100 } = query as Record<string, number>;
  const logs = await AdminLog.find()
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .populate('adminId', 'username email')
    .lean();
  return { logs, page, limit };
}

export async function logAdminAction({ adminId, adminName, action, targetId, targetName, details, ip }: {
  adminId: string;
  adminName: string;
  action: string;
  targetId?: string;
  targetName?: string;
  details?: string;
  ip?: string;
}): Promise<void> {
  await AdminLog.create({
    adminId,
    adminName,
    action,
    targetId,
    targetName,
    details,
    ip,
  });
}