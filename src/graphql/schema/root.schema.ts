export const rootSchema = `
  type HealthStatus {
    status: String!
    version: String
    uptime: Float
  }

  type Query {
    health: HealthStatus!
    me: User
    project(id: ID!): Project
    projects(limit: Int, offset: Int): [Project!]!
    upload(id: ID!): Upload
    uploads(limit: Int, offset: Int): [Upload!]!
    settings: Settings
    getShare(id: ID!): Project
    publicProfile(accountName: String!): PublicUser
    followList(accountName: String!, type: FollowListType!, offset: Int): FollowListResult!
    blockedUsers: [BlockedUser!]!
    playlist(id: ID!): Playlist
    playlists(accountName: String!): [Playlist!]!
    savedPlaylists: [Playlist!]!
    feed(offset: Int, limit: Int): FeedResult!
    userActivity(offset: Int, limit: Int): FeedResult!
    userActivityHeatmap: [ActivityHeatmapDay!]!
    searchProjects(query: String!, sortBy: SearchSort, offset: Int, limit: Int): SearchResult!
    searchUsers(query: String!, limit: Int): [FollowUser!]!
    trendingProjects(offset: Int, limit: Int): ProjectPage!
    popularPlaylists(offset: Int, limit: Int): PlaylistPage!
    suggestedUsers(limit: Int): [FollowUser!]!
    exploreStats: ExploreStats!
    publicProject(publicId: String!): Project
    projectReactions(publicId: String!): ProjectReactions!
    leaderboard(limit: Int, offset: Int): LeaderboardResult!
    badgeDefinitions: [BadgeDef!]!
    userShowcase(accountName: String!): [ShowcasedBadge!]!
    myMusicLibrary: [MusicLibraryEntry!]!
    userContentStats: ContentStats!
    adminAddictionLevels: [AddictionLevel!]!
  }

  type MusicLibraryEntry {
    artist: String!
    album: String!
    genre: String
    language: String
    trackCount: Int
    updatedAt: String
  }

  type Mutation {
    createProject(input: CreateProjectInput!): Project!
    updateProject(id: ID!, input: UpdateProjectInput!): Project!
    deleteProject(id: ID!): Boolean!
    updateLyrics(publicId: String!, input: UpdateLyricsInput!): Lyrics!
    updateProfile(input: UpdateProfileInput!): User!
    updateSettings(input: UpdateSettingsInput!): Settings!
    resetSettings: Boolean!
    saveMedia(input: SaveMediaInput!): Upload!
    deleteMedia(id: ID!): Boolean!
    cloneProject(id: ID!): Project!
    starProject(id: ID!): Project!
    unstarProject(id: ID!): Project!
    sendVerificationEmail: Boolean!
    follow(accountName: String!): Boolean!
    unfollow(accountName: String!): Boolean!
    blockUser(accountName: String!): Boolean!
    unblockUser(accountName: String!): Boolean!
    createPlaylist(input: CreatePlaylistInput!): Playlist!
    updatePlaylist(id: ID!, input: UpdatePlaylistInput!): Playlist!
    deletePlaylist(id: ID!): Boolean!
    addProjectToPlaylist(playlistId: ID!, publicId: ID!): Playlist!
    removeProjectFromPlaylist(playlistId: ID!, publicId: ID!): Playlist!
    reorderPlaylist(playlistId: ID!, publicIds: [ID!]!): Playlist!
    savePlaylist(playlistId: ID!): Boolean!
    unsavePlaylist(playlistId: ID!): Boolean!
    setForksEnabled(publicId: ID!, enabled: Boolean!): Project!
    boostProject(publicId: ID!): Boolean!
    reactToProject(publicId: String!, emoji: String!): ProjectReactions!
    updateShowcase(badgeIds: [String!]!, showcasePublic: Boolean): UpdateShowcaseResult!
    adminGrantBadge(userIdentifier: String!, badgeId: String!): Boolean!
    adminRevokeBadge(userId: ID!, badgeId: String!): Boolean!
    adminCreateBadge(input: BadgeDefInput!): BadgeDef!
    adminUpdateBadge(id: String!, input: BadgeDefInput!): BadgeDef!
    adminDeleteBadge(id: String!): Boolean!
    adminRetroactiveScan(badgeId: String!): RetroactiveResult!
    adminCreateAddictionLevel(input: AddictionLevelInput!): AddictionLevel!
    adminUpdateAddictionLevel(id: String!, input: AddictionLevelUpdateInput!): AddictionLevel!
    adminDeleteAddictionLevel(id: String!): Boolean!
  }

  input UpdateProfileInput {
    accountName: String
    displayName: String
    email: String
    bio: String
    avatarUrl: String
    showFollowers: Boolean
  }

  type LeaderboardUser {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    badges: [UserBadge!]!
    stats: UserStats
    progression: UserProgression
    streak: UserStreak
    projectCount: Int!
    totalStarsReceived: Int!
    totalForksReceived: Int!
  }

  type LeaderboardResult {
    users: [LeaderboardUser!]!
    total: Int!
    hasMore: Boolean!
  }

  type UserBadge {
    id: String!
    grantedAt: String!
    grantedBy: String!
  }

  type LocalizedString {
    en: String!
    es: String!
  }

  input LocalizedStringInput {
    en: String!
    es: String
  }

  type ShowcasedBadge {
    id: String!
    label: LocalizedString!
    icon: String!
    color: String!
    rarity: String!
    rarityPct: Float!
    holderCount: Int!
    grantedAt: String!
  }

  type UpdateShowcaseResult {
    success: Boolean!
    error: String
    showcaseSlots: Int!
    level: Int!
    showcasePublic: Boolean!
  }

  type BadgeDef {
    id: String!
    label: LocalizedString!
    description: LocalizedString!
    icon: String!
    color: String!
    conditionType: String!
    conditionValue: Int
    autoGrant: Boolean!
    isBuiltin: Boolean!
    holderCount: Int!
    xpReward: Int!
  }

  input BadgeDefInput {
    id: String
    label: LocalizedStringInput!
    description: LocalizedStringInput
    icon: String
    color: String!
    conditionType: String!
    conditionValue: Int
    autoGrant: Boolean
    xpReward: Int
  }

  type RetroactiveResult {
    granted: Int!
    scanned: Int!
    error: String
  }

  type ActivityHeatmapDay {
    date: String!
    count: Int!
  }

  type ProjectStats {
    title: String!
    count: Int!
  }

  type ContentStats {
    totalProjects: Int!
    totalLines: Int!
    syncedLines: Int!
    completionPercentage: Float!
    averageProjectCompletion: Float!
    averageLinesPerProject: Float!
    fullySyncedProjects: Int!
    musicSyncedMinutes: Int!
    musicSyncedSeconds: Int!
    wordsTimestamped: Int!
    karaokeLines: Int!
    publicProjects: Int!
    starsReceived: Int!
    forksReceived: Int!
    mostSyncedProject: ProjectStats
    largestProject: ProjectStats
    syncTrendPercentage: Float!
    addictionId: String!
    addictionTitle: LocalizedString!
    currentStreak: Int!
    longestStreak: Int!
  }
  type AddictionLevelRequirements {
    syncedLines: Int
    karaokeLines: Int
    musicSyncedMinutes: Int
    publicProjects: Int
    starsReceived: Int
    wordsTimestamped: Int
    totalProjects: Int
  }

  type AddictionLevel {
    id: String!
    title: LocalizedString!
    description: LocalizedString!
    requirements: AddictionLevelRequirements!
    order: Int!
  }

  input AddictionLevelRequirementsInput {
    syncedLines: Int
    karaokeLines: Int
    musicSyncedMinutes: Int
    publicProjects: Int
    starsReceived: Int
    wordsTimestamped: Int
    totalProjects: Int
  }

  input AddictionLevelInput {
    id: String!
    title: LocalizedStringInput!
    description: LocalizedStringInput
    requirements: AddictionLevelRequirementsInput
    order: Int
  }

  input AddictionLevelUpdateInput {
    title: LocalizedStringInput
    description: LocalizedStringInput
    requirements: AddictionLevelRequirementsInput
    order: Int
  }
`;
