export const userSchema = `
  type User {
    id: ID!
    username: String
    email: String
    avatarUrl: String
    bio: String
    isVerified: Boolean!
    isBanned: Boolean!
    bannedUntil: String
    banReason: String
    appealStatus: String
    banAppeal: String
    showUnbanMessage: Boolean
    role: String!
    createdAt: String
    passwordChangedAt: String
    hasPassword: Boolean!
    spotify: SpotifyInfo
    google: GoogleInfo
    projects: [Project!]!
    uploads: [Upload!]!
    settings: Settings
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
`;
