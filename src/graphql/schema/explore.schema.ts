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

  enum ExploreEventType {
    IMPRESSION
    CLICK
  }

  input ExploreEventInput {
    publicId: String!
    type: ExploreEventType!
    "0-based position in the feed; used for impressions."
    position: Int
  }

  extend type Mutation {
    "Anonymous feed telemetry (no user/device stored). At most 50 events per call; unknown or non-public projects are ignored."
    trackExploreEvents(events: [ExploreEventInput!]!): Boolean!
  }
`;
