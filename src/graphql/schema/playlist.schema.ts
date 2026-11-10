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
    viewCount: Int!
    shareCount: Int!
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

  "Sort order for a user's playlists page."
  enum PlaylistListSort {
    UPDATED
    NEWEST
    SAVES
    NAME
  }

  "Owner-only filter on a user's playlists page; other viewers always get public lists only."
  enum PlaylistVisibilityFilter {
    ALL
    PUBLIC
    PRIVATE
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
