export const wallSchema = `
  type WallAuthor {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    staffRole: String
  }

  type WallComment {
    id: ID!
    body: String!
    createdAt: String!
    "0 for a comment, 1 for a reply, 2 for a reply to a reply."
    depth: Int!
    author: WallAuthor!
    canDelete: Boolean!
    replies: [WallComment!]!
  }

  type Wall {
    "False when the owner turned their wall off."
    enabled: Boolean!
    comments: [WallComment!]!
    hasMore: Boolean!
    "Top-level comments, not counting replies."
    total: Int!
    "Whether the viewer is told about new comments on this wall."
    subscribed: Boolean!
  }
`;
