export const activitySchema = `
  type Activity {
    id: ID!
    actor: FollowUser!
    "Who it was done to: the followed user, or the project's owner for a star, fork or share. Null for the rest, or when they are gone. Only id, accountName, displayName and avatarUrl are populated."
    target: FollowUser
    type: ActivityType!
    publicId: String!
    projectTitle: String!
    coverImage: String
    targetPath: String
    "PROJECT_SHARED only: the sharer's note and tags."
    description: String
    tags: [String!]
    createdAt: String!
  }

  enum ActivityType {
    PROJECT_PUBLISHED
    PROJECT_STARRED
    PROJECT_FORKED
    PROJECT_SHARED
    PLAYLIST_CREATED
    USER_FOLLOWED
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
