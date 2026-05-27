import User from '../../db/user.model.js';

export async function searchUsers(query: string, limit = 10) {
  if (!query.trim()) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  const users = await User.find({
    isDeleted: { $ne: true },
    'ban.active': { $ne: true },
    $or: [{ accountName: regex }, { displayName: regex }],
  })
    .select('accountName displayName avatarUrl')
    .limit(Math.min(limit, 20))
    .lean();

  return users.map((u: any) => ({
    id: u._id.toString(),
    accountName: u.accountName,
    displayName: u.displayName ?? null,
    avatarUrl: u.avatarUrl ?? null,
  }));
}
