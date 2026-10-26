export const wallSchema = `
  type WallAuthor {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    staffRole: String
  }

  "A person tagged in a comment, as @[u:<id>] in its body."
  type WallMention {
    id: ID!
    accountName: String!
    displayName: String
  }

  "A project tagged in a comment, as @[p:<publicId>] in its body. Only listed when the viewer may see it."
  type WallProjectRef {
    publicId: ID!
    title: String!
    slug: String!
    coverImage: String
    ownerAccountName: String!
  }

  type WallComment {
    id: ID!
    "May contain tag tokens; resolve them through mentions and projectRefs."
    body: String!
    mentions: [WallMention!]!
    projectRefs: [WallProjectRef!]!
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
