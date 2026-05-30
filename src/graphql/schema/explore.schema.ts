export const exploreSchema = `
  type ProjectPage {
    projects: [Project!]!
    total: Int!
    hasMore: Boolean!
  }

  type PlaylistPage {
    playlists: [Playlist!]!
    total: Int!
    hasMore: Boolean!
  }

  type ExploreStats {
    totalProjects: Int!
    totalUsers: Int!
    totalPlaylists: Int!
  }
`;
