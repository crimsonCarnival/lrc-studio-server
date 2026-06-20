export const playlistSchema = `
  type Playlist {
    id: ID!
    owner: FollowUser!
    name: String!
    description: String
    coverImage: String
    tags: [String!]!
    isPublic: Boolean!
    sortMode: PlaylistSortMode!
    projects: [Project!]!
    projectCount: Int!
    savedCount: Int!
    isSavedByMe: Boolean!
    createdAt: String!
    updatedAt: String!
    trendingScore: Float
  }

  enum PlaylistSortMode {
    MANUAL
    DATE_ADDED
    STARS
    ALPHABETICAL
  }

  input CreatePlaylistInput {
    name: String!
    description: String
    coverImage: String
    tags: [String!]
    isPublic: Boolean
    sortMode: PlaylistSortMode
    publicIds: [ID!]
  }

  input UpdatePlaylistInput {
    name: String
    description: String
    coverImage: String
    tags: [String!]
    isPublic: Boolean
    sortMode: PlaylistSortMode
  }
`;
