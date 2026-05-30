export const commentSchema = `
  type Comment {
    id: ID!
    projectId: String!
    user: FollowUser!
    text: String!
    parentId: ID
    replyCount: Int!
    reactions: [ReactionSummary!]!
    myReaction: String
    isDeleted: Boolean!
    createdAt: String!
    updatedAt: String!
  }

  type ReactionSummary {
    emoji: String!
    count: Int!
  }

  type CommentPage {
    comments: [Comment!]!
    total: Int!
    hasMore: Boolean!
  }

  type ProjectReactions {
    reactions: [ReactionSummary!]!
    myReaction: String
  }
`;
