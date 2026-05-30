export const commentSchema = `
  type ReactionSummary {
    emoji: String!
    count: Int!
  }

  type ProjectReactions {
    reactions: [ReactionSummary!]!
    myReaction: String
  }
`;
