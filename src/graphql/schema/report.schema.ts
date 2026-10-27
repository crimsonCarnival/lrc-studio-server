export const reportSchema = `
  "A person as reports show them."
  type ReportUser {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    staffRole: String
  }

  "A reported wall comment, with the comment it answers for moderators."
  type ReportCommentTarget {
    comment: WallReportComment!
    "The comment it answers, for context (moderators only); null for a top-level comment."
    parent: WallReportComment
    wallAccountName: String!
  }

  "A reported account."
  type ReportUserTarget {
    id: ID!
    accountName: String!
    displayName: String
    avatarUrl: String
    "The first 200 characters."
    bio: String!
    createdAt: String
    banned: Boolean!
  }

  "A reported project."
  type ReportProjectTarget {
    id: ID!
    publicId: String!
    slug: String!
    title: String!
    artist: String
    coverImage: String
    ownerAccountName: String!
    public: Boolean!
  }

  "A reported playlist."
  type ReportPlaylistTarget {
    id: ID!
    name: String!
    coverImage: String
    ownerAccountName: String!
    projectCount: Int!
    public: Boolean!
  }

  "One person's report, as moderators see it."
  type ReportEntry {
    id: ID!
    reason: String!
    note: String!
    status: String!
    createdAt: String!
    resolvedAt: String
    reporter: ReportUser
  }

  "Every report on one target, for moderators. The preview field matching targetType is set; all are null once the target is gone."
  type ReportGroup {
    "wall_comment, user, project or playlist."
    targetType: String!
    targetId: ID!
    comment: ReportCommentTarget
    user: ReportUserTarget
    project: ReportProjectTarget
    playlist: ReportPlaylistTarget
    "For a wall comment: the wall's account name, kept once the comment is gone."
    wallAccountName: String
    reports: [ReportEntry!]!
    "Open reports on this target, whatever status was listed."
    openCount: Int!
    latestAt: String!
    "Who is accountable: the comment's author, the account itself, or the owner."
    subject: ReportUser
    "The subject's targets actioned after reports in the last 30 days."
    subjectActionedCount: Int!
    "The subject's wall-commenting restriction: an ISO date, 'forever', or null."
    subjectRestrictedUntil: String
  }

  "One of the viewer's own reports. The preview is null once the target is gone or no longer visible to them."
  type MyReport {
    id: ID!
    targetType: String!
    targetId: ID!
    comment: ReportCommentTarget
    user: ReportUserTarget
    project: ReportProjectTarget
    playlist: ReportPlaylistTarget
    reason: String!
    note: String!
    "open, dismissed or actioned."
    status: String!
    createdAt: String!
    resolvedAt: String
  }

  type MyReports {
    reports: [MyReport!]!
    total: Int!
  }

  extend type Query {
    "Reports grouped by target, for moderators (users.ban). status: open (default), dismissed or actioned; targetType filters."
    reportGroups(status: String, targetType: String, limit: Int): [ReportGroup!]!
    "Targets with open reports, for moderators (users.ban)."
    openReportCount: Int!
    "The viewer's own reports and what became of them, newest first."
    myReports(limit: Int, offset: Int): MyReports!
  }

  extend type Mutation {
    "targetType: wall_comment, user, project or playlist; targetId is its id (a project's publicId also works). reason depends on the type. alsoBlock (accounts only) blocks it too."
    fileReport(targetType: String!, targetId: ID!, reason: String!, note: String, alsoBlock: Boolean): Boolean!
    "Moderators only. action: dismiss or action. Acting on a project or playlist deletes it and needs sudo."
    resolveReportGroup(targetType: String!, targetId: ID!, action: String!): Boolean!
  }
`;
