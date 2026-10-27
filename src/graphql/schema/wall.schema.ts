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
    "visible, pending (waiting for the owner's approval) or hidden (by the owner or a moderator)."
    status: String!
    "For a pending comment: approval (the owner's setting) or muted_word."
    heldReason: String
    "The viewer may approve, hide and unhide it: the wall's owner, or a moderator."
    canModerate: Boolean!
    "How many times it was edited; see wallCommentHistory."
    revisionCount: Int!
    reactions: [WallReaction!]!
    "For a top-level comment: the viewer muted replies in its thread."
    mutedByMe: Boolean!
  }

  type WallReaction {
    "A quick-reaction code or one emoji."
    emoji: String!
    count: Int!
    mine: Boolean!
  }

  type WallCommentRevision {
    body: String!
    "When this version was written."
    editedAt: String!
    current: Boolean!
  }

  type WallLikers {
    users: [WallAuthor!]!
    total: Int!
  }

  type WallReportComment {
    id: ID!
    body: String!
    mentions: [WallMention!]!
    projectRefs: [WallProjectRef!]!
    author: WallAuthor
    createdAt: String!
    status: String!
  }

  type WallReport {
    id: ID!
    reason: String!
    note: String!
    status: String!
    createdAt: String!
    "When a moderator settled it."
    resolvedAt: String
    openCount: Int!
    reporter: WallAuthor
    wallAccountName: String!
    "Null once the comment is gone."
    comment: WallReportComment
  }

  "Every report on one comment, for moderators."
  type WallReportGroup {
    commentId: ID!
    wallAccountName: String!
    "Null once the comment is gone."
    comment: WallReportComment
    "The comment it answers, for context."
    parent: WallReportComment
    reports: [WallReport!]!
    openCount: Int!
    latestAt: String!
    "The author's comments removed after reports in the last 30 days."
    authorActionedCount: Int!
    "ISO date, 'forever', or null when the author may comment."
    authorRestrictedUntil: String
  }

  type MyWallReports {
    reports: [WallReport!]!
    total: Int!
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
    "newest, oldest or top."
    sort: String!
    "The viewer may post: signed in, allowed by the owner's setting, not restricted."
    canComment: Boolean!
    "The owner's setting: everyone, following or nobody."
    commentPolicy: String!
    "The viewer's own commenting restriction: an ISO date, 'forever', or null."
    restrictedUntil: String
    "For the owner and moderators: comments waiting for approval."
    pendingCount: Int!
  }
`;
