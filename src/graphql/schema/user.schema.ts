export const userSchema = `
  type UserStats {
    minutesSynced: Float
    secondsSynced: Float
    wordsSynced: Float
    karaokeLines: Float
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
    bio: String
    isVerified: Boolean!
    ban: UserBan
    appeal: UserAppeal
    wasJustUnbanned: Boolean
    role: String!
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
    badges: [UserBadge!]!
    showcasedBadges: [String!]!
    stats: UserStats
    streak: UserStreak
    progression: UserProgression
    showcaseSlots: Int!
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
    bio: String
    isVerified: Boolean!
    isAdmin: Boolean!
    createdAt: String
    projects: [Project!]!
    projectCount: Int!
    totalStarsReceived: Int!
    totalForksReceived: Int!
    followerCount: Int!
    followingCount: Int!
    isFollowedByMe: Boolean!
    isBlockedByMe: Boolean!
    showFollowers: Boolean!
    badges: [UserBadge!]!
    showcasedBadges: [ShowcasedBadge!]!
    showcasePublic: Boolean!
    stats: UserStats
    streak: UserStreak
    progression: UserProgression
  }

  type FollowUser {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    isFollowedByMe: Boolean!
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
  }
`;
