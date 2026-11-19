export const catalogSchema = `
  enum CatalogKind {
    artist
    album
  }

  enum CatalogDecision {
    approve
    reject
  }

  enum CatalogImageSource {
    upload
    genius
  }

  type CatalogArtist {
    id: ID!
    name: String!
    disambiguation: String!
    slug: String
    imageUrl: String
    imageSource: CatalogImageSource
    imageSourceUrl: String
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

  # An approved album as the artist page shows it. songCount counts public songs crediting the artist
  # as primary; coverUrl is the album cover, else the first such song's cover.
  type CatalogAlbumCard {
    album: CatalogAlbum!
    songCount: Int!
    coverUrl: String
  }

  # Public: an approved artist with its approved albums. Reviewer-only fields are always null here.
  type CatalogArtistPage {
    artist: CatalogArtist!
    albums: [CatalogAlbum!]!
    # The albums to show: approved catalog albums only, never titles taken from songs.
    albumCards: [CatalogAlbumCard!]!
    # Every public song crediting this artist, from any user (capped at 500).
    songs: [Project!]!
  }

  # Public: one approved album of an approved artist, with the public songs that credit the artist
  # as primary and name this album, in track order.
  type CatalogAlbumPage {
    artist: CatalogArtist!
    album: CatalogAlbum!
    songs: [Project!]!
    coverUrl: String
  }

  type CatalogArtistRef {
    name: String!
    # artistKey(name): match it against the lower-cased, NFC-normalised name you asked for.
    key: String!
    slug: String!
  }

  # Aggregate only: no project ids, titles or owners.
  type DetectedAlbum {
    key: String!
    title: String!
    songCount: Int!
    year: String
  }

  extend type Query {
    # Public. Approved catalog artists matching these names; unknown names are left out (max 50 names).
    catalogArtistSlugs(names: [String!]!): [CatalogArtistRef!]!
    # Null when the slug is unknown or the entry is not approved.
    catalogArtist(slug: String!): CatalogArtistPage
    # Null when either slug is unknown or either entry is not approved.
    catalogAlbum(artistSlug: String!, albumSlug: String!): CatalogAlbumPage
    myCatalogSubmissions: MyCatalogSubmissions!
    catalogReviewQueue: CatalogQueue!
    catalogAdminArtists(query: String, offset: Int, limit: Int): [CatalogArtist!]!
    catalogAdminAlbums(artistId: ID!): [CatalogAlbum!]!
    catalogDetectAlbums(artistId: ID!): [DetectedAlbum!]!
  }

  extend type Mutation {
    submitCatalogArtist(name: String!, bio: String, imageUrl: String): CatalogArtist!
    submitCatalogAlbum(artistId: ID!, title: String!, year: String, coverUrl: String): CatalogAlbum!
    updateMyCatalogEntry(kind: CatalogKind!, id: ID!, name: String, title: String, bio: String, imageUrl: String, year: String, coverUrl: String): Boolean!
    withdrawMyCatalogEntry(kind: CatalogKind!, id: ID!): Boolean!
    reviewCatalogEntry(kind: CatalogKind!, id: ID!, decision: CatalogDecision!, note: String, expectedUpdatedAt: String): Boolean!
    adminCreateCatalogArtist(name: String!, disambiguation: String, bio: String, imageUrl: String, imageSource: CatalogImageSource, imageSourceUrl: String): CatalogArtist!
    adminCreateCatalogAlbum(artistId: ID!, title: String!, year: String, coverUrl: String): CatalogAlbum!
    adminUpdateCatalogEntry(kind: CatalogKind!, id: ID!, name: String, disambiguation: String, title: String, bio: String, imageUrl: String, year: String, coverUrl: String, imageSource: CatalogImageSource, imageSourceUrl: String): Boolean!
    # Creates approved albums from the album names on the artist's public songs; returns how many were new.
    adminImportCatalogAlbums(artistId: ID!): Int!
    adminDeleteCatalogEntry(kind: CatalogKind!, id: ID!, revokeCredit: Boolean): Boolean!
    approveDetectedAlbum(artistId: ID!, title: String!, year: String): CatalogAlbum!
    dismissDetectedAlbum(artistId: ID!, key: String!): Boolean!
  }
`;
