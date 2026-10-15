export const artistSchema = `
  type ArtistSuggestion {
    id: ID!
    name: String!
  }

  type ArtistSuggestionPage {
    items: [ArtistSuggestion!]!
    total: Int!
  }

  enum ArtistParseFlagCode {
    ambiguous_separator
    weak_marker
    empty_feat_segment
    unbalanced_bracket
    duplicate_removed
  }

  type ArtistParseFlag {
    code: ArtistParseFlagCode!
    source: String!
    text: String!
  }

  type ParsedArtists {
    artists: [ParsedArtistCredit!]!
    # The title with its feat. segment removed; null when nothing was extracted from it.
    title: String
    flags: [ArtistParseFlag!]!
    # The formatted result, e.g. "Drake feat. Rihanna".
    display: String!
  }

  type ParsedArtistCredit {
    name: String!
    role: ArtistRole!
    order: Int!
  }

  extend type Query {
    # Prefix match over the caller's own artists only. limit is capped at 20.
    myArtistSuggestions(prefix: String!, limit: Int, offset: Int): ArtistSuggestionPage!
    # Pure helper for the UI: what the server would read out of an artist string / title.
    parseArtists(artist: String!, title: String): ParsedArtists!
  }
`;
