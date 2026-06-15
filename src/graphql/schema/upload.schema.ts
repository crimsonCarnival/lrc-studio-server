export const uploadSchema = `
  type Upload {
    id: ID!
    source: String!
    uploadUrl: String
    publicId: String
    youtubeUrl: String
    spotifyTrackId: String
    artist: String
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
    youtubeUrl: String
    spotifyTrackId: String
    artist: String
    fileName: String
    title: String
    duration: Float
  }
`;
