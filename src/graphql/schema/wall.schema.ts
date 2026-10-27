export const wallSchema = `
  type WallAuthor {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    staffRole: String
    "False when this author switched tagging off."
    allowsTags: Boolean!
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
    editedAt: String
    canEdit: Boolean!
    pinned: Boolean!
    "It answered a sibling that is no longer shown."
    replyToMissing: Boolean!
    "Direct replies in total, and everything beneath; replies may hold only the first few."
    replyCount: Int!
    descendantCount: Int!
    "0 for a comment, 1 for a reply, 2 for a reply to a reply."
    depth: Int!
    author: WallAuthor!
    canDelete: Boolean!
    likeCount: Int!
    likedByMe: Boolean!
    "For a reply at the deepest level: the sibling it answers (it is listed right after it)."
    replyToId: ID
    replies: [WallComment!]!
  }

  type WallLikers {
    users: [WallAuthor!]!
    total: Int!
  }

  type WallReportComment {
    id: ID!
    body: String!
    author: WallAuthor
    createdAt: String!
  }

  type WallReport {
    id: ID!
    reason: String!
    note: String!
    status: String!
    createdAt: String!
    openCount: Int!
    reporter: WallAuthor
    wallAccountName: String!
    "Null once the comment is gone."
    comment: WallReportComment
  }

  type WallLikeResult {
    liked: Boolean!
    likeCount: Int!
  }

  type Wall {
    "False when the owner turned their wall off."
    enabled: Boolean!
    comments: [WallComment!]!
    hasMore: Boolean!
    "Every comment, replies included."
    totalAll: Int!
    page: Int!
    "Top-level comments, not counting replies."
    total: Int!
    "Whether the viewer is told about new comments on this wall."
    subscribed: Boolean!
  }
`;
