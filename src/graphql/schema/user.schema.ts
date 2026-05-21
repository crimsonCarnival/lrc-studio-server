export const userSchema = `
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
    showUnbanMessage: Boolean
    role: String!
    createdAt: String
    passwordChangedAt: String
    lastAccountNameChangedAt: String
    pendingEmail: String
    accountNameChangeCount: Int!
    previousAccountNames: [NameChange!]!
    emailHistory: [EmailChange!]!
    hasPassword: Boolean!
    spotify: SpotifyInfo
    google: GoogleInfo
    projects: [Project!]!
    uploads: [Upload!]!
    settings: Settings
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

  type SpotifyInfo {
    connected: Boolean!
    spotifyId: String
    isPremium: Boolean!
    profilePictureUrl: String
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
`;
