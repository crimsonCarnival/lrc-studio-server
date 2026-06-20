export const reactionSchema = `
  type ReactionSummary {
    emoji: String!
    count: Int!
  }

  type ProjectReactions {
    reactions: [ReactionSummary!]!
    myReaction: String
  }
`;
