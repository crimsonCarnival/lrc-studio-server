export const collabSchema = `
  "Someone in a live collaborative session. subject is user:<id> or guest:<id>."
  type CollabParticipant {
    subject: String!
    name: String!
    "owner, editor or viewer."
    role: String!
    "1-8, maps to --color-collab-<n>."
    colorIndex: Int!
    "Guests only, owner only: the invite they joined with. Kicking a guest revokes it."
    inviteId: ID
    avatarUrl: String
  }

  type CollabInvite {
    id: ID!
    "editor or viewer."
    role: String!
    revoked: Boolean!
    createdAt: String!
  }

  type CollabSession {
    id: ID!
    publicId: String!
    allowGuests: Boolean!
    members: [CollabParticipant!]!
    "Owner only; empty for everyone else."
    invites: [CollabInvite!]!
  }

  type CollabKickResult {
    "The invite a kicked guest joined with, now revoked, so every other guest on that link is cut off too. Null for a signed-in user."
    revokedInviteId: ID
  }

  extend type Query {
    "The live session, for its owner or a signed-in member; null otherwise."
    collabSession(publicId: String!): CollabSession
  }

  extend type Mutation {
    "Idempotent: returns the live session if one exists."
    startCollabSession(publicId: String!): CollabSession!
    endCollabSession(publicId: String!): Boolean!
    "Returns the raw invite token. It is stored hashed and never returned again."
    createCollabInvite(publicId: String!, role: String!): String!
    revokeCollabInvite(publicId: String!, inviteId: ID!): Boolean!
    setCollabRole(publicId: String!, subject: String!, role: String!): Boolean!
    kickCollabParticipant(publicId: String!, subject: String!): CollabKickResult!
    setCollabGuestAccess(publicId: String!, allowGuests: Boolean!): Boolean!
    "Owner only. Removes a collaborator credit and stops it being re-added. id is the credit's subject."
    removeProjectCollaborator(publicId: String!, id: ID!): Boolean!
  }
`;
