export const activitySchema = `
  type Activity {
    id: ID!
    actor: FollowUser!
    type: ActivityType!
    projectId: String!
    projectTitle: String!
    coverImage: String
    createdAt: String!
  }

  enum ActivityType {
    PROJECT_PUBLISHED
    PROJECT_STARRED
    PROJECT_FORKED
  }

  type FeedResult {
    activities: [Activity!]!
    hasMore: Boolean!
  }

  enum SearchSort {
    RELEVANCE
    STARS
    NEWEST
  }

  type SearchResult {
    projects: [Project!]!
    total: Int!
  }
`;
