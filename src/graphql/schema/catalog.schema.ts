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
    # The signed-in viewer's own artist for this name, when they have songs crediting it as primary
    # (private ones included). Null for anonymous viewers.
    viewerShelf: CatalogViewerShelf
  }

  # Public: one approved album of an approved artist, with the public songs that credit the artist
  # as primary and name this album, in track order.
  type CatalogAlbumPage {
    artist: CatalogArtist!
    album: CatalogAlbum!
    songs: [Project!]!
    coverUrl: String
  }

  # Autocomplete row: an approved artist (name, disambiguation) or album (title as name).
  type CatalogSuggestion {
    id: ID!
    name: String!
    slug: String
    disambiguation: String!
    # Artists only; null when the artist has no photo.
    imageUrl: String
  }

  type CatalogArtistList {
    items: [CatalogArtist!]!
    total: Int!
  }

  type CatalogViewerShelf {
    artistId: ID!
    songCount: Int!
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

  # Aggregate only: no project ids, titles or owners.
  type DetectedArtist {
    key: String!
    name: String!
    songCount: Int!
  }

  extend type Query {
    # Public. Approved catalog artists matching these names; unknown names are left out (max 50 names).
    catalogArtistSlugs(names: [String!]!): [CatalogArtistRef!]!
    # Null when the slug is unknown or the entry is not approved.
    catalogArtist(slug: String!): CatalogArtistPage
    # Public browse/search of approved artists, A to Z. query matches anywhere in the name,
    # case-insensitively. limit defaults to 24, max 48. Reviewer-only fields are always null.
    catalogArtists(query: String, offset: Int, limit: Int): CatalogArtistList!
    # Null when either slug is unknown or either entry is not approved.
    catalogAlbum(artistSlug: String!, albumSlug: String!): CatalogAlbumPage
    # Public autocomplete. artist: names starting with prefix. album: approved albums of the one
    # approved artist named artist (empty for unknown names and homonyms). limit defaults to 8, max 20.
    catalogSuggestions(kind: CatalogKind!, prefix: String, artist: String, limit: Int): [CatalogSuggestion!]!
    myCatalogSubmissions: MyCatalogSubmissions!
    catalogReviewQueue: CatalogQueue!
    catalogAdminArtists(query: String, offset: Int, limit: Int): [CatalogArtist!]!
    catalogAdminAlbums(artistId: ID!): [CatalogAlbum!]!
    catalogDetectAlbums(artistId: ID!): [DetectedAlbum!]!
    # Primary artist names on songs that have no catalog entry and were not dismissed.
    catalogDetectArtists: [DetectedArtist!]!
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
    approveDetectedArtist(name: String!): CatalogArtist!
    dismissDetectedArtist(key: String!): Boolean!
  }
`;
