export const catalogSchema = `
  enum CatalogKind {
    artist
    album
  }

  enum CatalogDecision {
    approve
    reject
  }

  type CatalogArtist {
    id: ID!
    name: String!
    disambiguation: String!
    slug: String
    imageUrl: String
    bio: String!
    status: String!
    source: String!
    # The submitter. Only reachable through the caller's own submissions, the review queue and admin lists.
    submittedBy: FollowUser
    # Visible to the submitter and reviewers only.
    reviewNote: String
    createdAt: String!
    # ISO; echo it back as expectedUpdatedAt so a review fails if the entry was edited meanwhile.
    updatedAt: String!
  }

  type CatalogAlbum {
    id: ID!
    artistId: ID!
    title: String!
    slug: String
    year: String
    coverUrl: String
    status: String!
    source: String!
    submittedBy: FollowUser
    reviewNote: String
    createdAt: String!
    updatedAt: String!
  }

  type MyCatalogSubmissions {
    artists: [CatalogArtist!]!
    albums: [CatalogAlbum!]!
  }

  type CatalogQueue {
    artists: [CatalogArtist!]!
    albums: [CatalogAlbum!]!
  }

  extend type Query {
    myCatalogSubmissions: MyCatalogSubmissions!
    catalogReviewQueue: CatalogQueue!
    catalogAdminArtists(query: String, offset: Int, limit: Int): [CatalogArtist!]!
    catalogAdminAlbums(artistId: ID!): [CatalogAlbum!]!
  }

  extend type Mutation {
    submitCatalogArtist(name: String!, bio: String, imageUrl: String): CatalogArtist!
    submitCatalogAlbum(artistId: ID!, title: String!, year: String, coverUrl: String): CatalogAlbum!
    updateMyCatalogEntry(kind: CatalogKind!, id: ID!, name: String, title: String, bio: String, imageUrl: String, year: String, coverUrl: String): Boolean!
    withdrawMyCatalogEntry(kind: CatalogKind!, id: ID!): Boolean!
    reviewCatalogEntry(kind: CatalogKind!, id: ID!, decision: CatalogDecision!, note: String, expectedUpdatedAt: String): Boolean!
    adminCreateCatalogArtist(name: String!, disambiguation: String, bio: String, imageUrl: String): CatalogArtist!
    adminCreateCatalogAlbum(artistId: ID!, title: String!, year: String, coverUrl: String): CatalogAlbum!
    adminUpdateCatalogEntry(kind: CatalogKind!, id: ID!, name: String, disambiguation: String, title: String, bio: String, imageUrl: String, year: String, coverUrl: String): Boolean!
    adminDeleteCatalogEntry(kind: CatalogKind!, id: ID!, revokeCredit: Boolean): Boolean!
  }
`;
