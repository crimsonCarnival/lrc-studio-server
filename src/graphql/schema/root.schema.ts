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
    playlist(id: ID!): Playlist
    playlists(accountName: String!): [Playlist!]!
    savedPlaylists: [Playlist!]!
    feed(offset: Int, limit: Int): FeedResult!
    userActivity(offset: Int, limit: Int): FeedResult!
    searchProjects(query: String!, sortBy: SearchSort, offset: Int, limit: Int): SearchResult!
    searchUsers(query: String!, limit: Int): [FollowUser!]!
    trendingProjects(offset: Int, limit: Int): ProjectPage!
    popularPlaylists(offset: Int, limit: Int): PlaylistPage!
    suggestedUsers(limit: Int): [FollowUser!]!
    exploreStats: ExploreStats!
    publicProject(projectId: String!): Project
    projectReactions(projectId: String!): ProjectReactions!
    leaderboard(limit: Int, offset: Int): LeaderboardResult!
    badgeDefinitions: [BadgeDef!]!
    userShowcase(accountName: String!): [ShowcasedBadge!]!
    myMusicLibrary: [MusicLibraryEntry!]!
    userContentStats: ContentStats!
  }

  type Mutation {
    createProject(input: CreateProjectInput!): Project!
    updateProject(id: ID!, input: UpdateProjectInput!): Project!
    deleteProject(id: ID!): Boolean!
    updateLyrics(projectId: String!, input: UpdateLyricsInput!): Lyrics!
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
    createPlaylist(input: CreatePlaylistInput!): Playlist!
    updatePlaylist(id: ID!, input: UpdatePlaylistInput!): Playlist!
    deletePlaylist(id: ID!): Boolean!
    addProjectToPlaylist(playlistId: ID!, projectId: ID!): Playlist!
    removeProjectFromPlaylist(playlistId: ID!, projectId: ID!): Playlist!
    reorderPlaylist(playlistId: ID!, projectIds: [ID!]!): Playlist!
    savePlaylist(playlistId: ID!): Boolean!
    unsavePlaylist(playlistId: ID!): Boolean!
    setForksEnabled(projectId: ID!, enabled: Boolean!): Project!
    boostProject(projectId: ID!): Boolean!
    reactToProject(projectId: String!, emoji: String!): ProjectReactions!
    updateShowcase(badgeIds: [String!]!, showcasePublic: Boolean): UpdateShowcaseResult!
    adminGrantBadge(userIdentifier: String!, badgeId: String!): Boolean!
    adminRevokeBadge(userId: ID!, badgeId: String!): Boolean!
    adminCreateBadge(input: BadgeDefInput!): BadgeDef!
    adminUpdateBadge(id: String!, input: BadgeDefInput!): BadgeDef!
    adminDeleteBadge(id: String!): Boolean!
    adminRetroactiveScan(badgeId: String!): RetroactiveResult!
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
    minutesSynced: Int!
    wordsSynced: Int!
    karaokeLines: Int!
    level: Int!
    xp: Int!
    currentStreak: Int!
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

  type ShowcasedBadge {
    id: String!
    label: String!
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
    label: String!
    description: String!
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
    label: String!
    description: String
    icon: String!
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

  type MusicLibraryEntry {
    artist: String
    album: String
    genre: String
    language: String
    trackCount: Int
  }

  type ProjectStats {
    title: String!
    count: Int!
  }

  type ContentStats {
    totalProjects: Int!
    totalLines: Int!
    syncedLines: Int!
    completionPercentage: Int!
    averageProjectCompletion: Int!
    averageLinesPerProject: Int!
    fullySyncedProjects: Int!
    musicSyncedMinutes: Int!
    wordsTimestamped: Int!
    karaokeLines: Int!
    publicProjects: Int!
    starsReceived: Int!
    forksReceived: Int!
    mostSyncedProject: ProjectStats
    largestProject: ProjectStats
    syncTrendPercentage: Int!
  }
`;
