export const CATALOG_LIMITS = {
  maxArtistName: 300,
  maxAlbumTitle: 500,
  maxBio: 1000,
  maxDisambiguation: 80,
  maxYear: 4,
  /** Pending submissions per user, artists and albums combined. */
  maxPending: 5,
  /** Submissions per user in a rolling 24h window, artists and albums combined. */
  maxPerDay: 10,
  windowMs: 24 * 60 * 60 * 1000,
} as const;
