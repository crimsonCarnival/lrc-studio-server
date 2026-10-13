import User from '../../db/user.model.js';

type SearchUserDoc = {
  _id: { toString(): string };
  accountName?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  projectCount?: number;
  progression?: { level?: number };
  social?: { followerCount?: number; totalStarsReceived?: number };
};

export async function searchUsers(query: string, limit = 10) {
  if (!query.trim()) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');

  const users = await User.find({
    isDeleted: { $ne: true },
    'ban.active': { $ne: true },
    'shadowBan.search': { $ne: true },
    $or: [{ accountName: regex }, { displayName: regex }],
  })
    // Counters are the denormalized ones the leaderboard and profile already show,
    // so a result row never disagrees with the page it links to.
    .select('accountName displayName avatarUrl projectCount progression.level social.followerCount social.totalStarsReceived')
    .limit(Math.min(limit, 20))
    .lean<SearchUserDoc[]>();

  return users.map((u) => ({
    id: u._id.toString(),
    accountName: u.accountName,
    displayName: u.displayName ?? null,
    avatarUrl: u.avatarUrl ?? null,
    level: u.progression?.level ?? 0,
    projectCount: u.projectCount ?? 0,
    totalStarsReceived: u.social?.totalStarsReceived ?? 0,
    followerCount: u.social?.followerCount ?? 0,
  }));
}
