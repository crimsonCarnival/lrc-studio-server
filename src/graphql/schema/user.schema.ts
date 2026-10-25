export const userSchema = `
  type UserStats {
    minutesSynced: Float
    secondsSynced: Float
    wordsSynced: Float
    karaokeLines: Float
    syncedLines: Float
    aiSyncedLines: Float
    aiWordsSynced: Float
  }

  type UserStreak {
    current: Int
    longest: Int
    lastActiveDate: String
  }

  type UserProgression {
    xp: Float
    level: Int
  }

  type User {
    id: ID!
    accountName: String
    displayName: String
    email: String
    avatarUrl: String
    coverImageUrl: String
    bio: String
    isVerified: Boolean!
    ban: UserBan
    appeal: UserAppeal
    wasJustUnbanned: Boolean
    role: String!
    # Public staff marker: "mod", "admin" or "superadmin"; null for everyone else.
    # Unlike User.role it never says "user" and is safe on public surfaces.
    staffRole: String
    permissions: [String!]!
    createdAt: String
    passwordChangedAt: String
    lastAccountNameChangedAt: String
    pendingEmail: String
    accountNameChangeCount: Int!
    previousAccountNames: [NameChange!]!
    emailHistory: [EmailChange!]!
    hasPassword: Boolean!
    google: GoogleInfo
    projects: [Project!]!
    uploads: [Upload!]!
    settings: Settings
    showFollowers: Boolean!
    onlineVisibility: String!
    lastOnlineVisibility: String!
    lastOnlineAt: String
    miniProfileBadgesEnabled: Boolean!
    miniProfileBadgeIds: [String!]!
    badges: [UserBadge!]!
    showcasedBadges: [String!]!
    showcasePublic: Boolean!
    stats: UserStats
    streak: UserStreak
    progression: UserProgression
    showcaseSlots: Int!
    country: String
    lastIp: String
    lastDevice: String
    lastLoginAt: String
  }

  type UserBan {
    active: Boolean!
    reason: String
    until: String
  }

  type UserAppeal {
    text: String
    status: String
    submittedAt: String
    resolvedAt: String
  }

  type GoogleInfo {
    connected: Boolean!
    googleId: String
    email: String
    name: String
    pictureUrl: String
  }

  type NameChange {
    from: String!
    to: String!
    changedAt: String!
  }

  type EmailChange {
    from: String!
    to: String!
    changedAt: String!
  }

  type PublicUser {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    coverImageUrl: String
    bio: String
    isVerified: Boolean!
    isAdmin: Boolean!
    # Public staff marker: "mod", "admin" or "superadmin"; null for everyone else.
    # Unlike User.role it never says "user" and is safe on public surfaces.
    staffRole: String
    createdAt: String
    projects: [Project!]!
    projectCount: Int!
    playlistCount: Int!
    totalStarsReceived: Int!
    totalForksReceived: Int!
    followerCount: Int!
    followingCount: Int!
    isFollowedByMe: Boolean!
    "off, uploads or all: what the viewer is told about this user's projects. off unless following."
    followNotify: String!
    isFollowingMe: Boolean!
    isBlockedByMe: Boolean!
    showFollowers: Boolean!
    miniProfileBadgeIds: [String!]!
    badges: [UserBadge!]!
    showcasedBadges: [ShowcasedBadge!]!
    showcasePublic: Boolean!
    stats: UserStats
    streak: UserStreak
    progression: UserProgression
    country: String
    lastOnlineAt: String
    # Whether the owner shows their XP progress bar to visitors. Off by default.
    showXpProgress: Boolean!
    # Null unless the owner enabled preferences.showActivityHeatmap.
    activityHeatmap: [ActivityHeatmapDay!]
  }

  type FollowUser {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    # Public staff marker: "mod", "admin" or "superadmin"; null for everyone else.
    # Unlike User.role it never says "user" and is safe on public surfaces.
    staffRole: String
    isFollowedByMe: Boolean!
    # Profile summary for result rows. Null on surfaces that do not load it
    # (only searchUsers does today), so clients must treat absence as "unknown".
    level: Int
    projectCount: Int
    totalStarsReceived: Int
    followerCount: Int
    # Same privacy rules as PublicUser.country (preferences.countryVisibility).
    country: String
  }

  type FollowListResult {
    users: [FollowUser!]!
    total: Int!
  }

  type BlockedUser {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    blockedAt: String
  }

  enum FollowListType {
    FOLLOWERS
    FOLLOWING
    FRIENDS
  }
`;
