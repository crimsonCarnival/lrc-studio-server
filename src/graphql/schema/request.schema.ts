export const requestSchema = `
  type StaffRequest {
    id: ID!
    requesterId: ID!
    requesterName: String!
    type: String!
    payload: String
    summary: String!
    status: String!
    reviewerName: String
    decisionNote: String
    error: String
    createdAt: String
    resolvedAt: String
  }

  type RequestCapabilities {
    submittable: [String!]!
    reviewable: [String!]!
  }

  extend type Query {
    myRequests: [StaffRequest!]!
    pendingRequests: [StaffRequest!]!
    requestCapabilities: RequestCapabilities!
  }

  extend type Mutation {
    submitRequest(type: String!, payload: String!): StaffRequest!
    reviewRequest(id: ID!, decision: String!, note: String): StaffRequest!
  }
`;
