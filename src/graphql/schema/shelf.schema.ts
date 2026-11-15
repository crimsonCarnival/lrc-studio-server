export const shelfSchema = `
  type ShelfTrack {
    project: Project!
    trackNumber: Int
  }

  type ShelfAlbum {
    key: String!
    title: String
    year: String
    isPublic: Boolean!
    trackCount: Int!
    coverImage: String
    # Empty on artistShelf; filled on artistShelfArtist.
    tracks: [ShelfTrack!]!
  }

  type ShelfArtist {
    id: ID!
    name: String!
    isPublic: Boolean!
    songCount: Int!
    albumCount: Int!
    coverImage: String
    # ISO timestamp of the newest edit among the artist's songs.
    latestEditAt: String!
    albums: [ShelfAlbum!]!
  }

  extend type Query {
    # Owner gets everything (private included); others and asVisitor get the visitor projection.
    artistShelf(accountName: String!, asVisitor: Boolean, withTracks: Boolean): [ShelfArtist!]!
    artistShelfArtist(accountName: String!, artistId: ID!, asVisitor: Boolean): ShelfArtist
  }

  extend type Mutation {
    # Owner only; artistId must be one of the caller's own artists. albumKey omitted = the artist row.
    setShelfVisibility(artistId: ID!, albumKey: String, isPublic: Boolean!): Boolean!
  }
`;
