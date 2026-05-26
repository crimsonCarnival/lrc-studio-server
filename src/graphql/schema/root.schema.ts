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
  }

  input UpdateProfileInput {
    accountName: String
    displayName: String
    email: String
    bio: String
    avatarUrl: String
    showFollowers: Boolean
  }
`;
