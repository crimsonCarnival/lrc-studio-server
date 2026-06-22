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

  type RequestCounts {
    pendingReview: Int!
    myPending: Int!
  }

  extend type Query {
    myRequests: [StaffRequest!]!
    pendingRequests: [StaffRequest!]!
    reviewedRequests: [StaffRequest!]!
    requestCapabilities: RequestCapabilities!
    requestCounts: RequestCounts!
  }

  extend type Mutation {
    submitRequest(type: String!, payload: String!): StaffRequest!
    reviewRequest(id: ID!, decision: String!, note: String): StaffRequest!
  }
`;
