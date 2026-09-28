export const uploadSchema = `
  type Upload {
    id: ID!
    source: String!
    uploadUrl: String
    publicId: String
    fileName: String!
    title: String!
    duration: Float
    coverImage: String
    user: User
    createdAt: String
    updatedAt: String
    projects: [Project!]!
  }

  input SaveMediaInput {
    source: String!
    uploadUrl: String
    publicId: String
    fileName: String
    title: String
    duration: Float
    # Byte size of the stored file. Without this the admin storage
    # totals stay at zero, since nothing else ever supplies it.
    sizeBytes: Float
  }
`;
