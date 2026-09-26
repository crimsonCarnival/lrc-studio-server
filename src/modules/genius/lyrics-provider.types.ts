/**
 * Shared shapes for the lyrics provider chain
 * (LRCLIB → LyricFind → lyrics.ovh).
 *
 * `extract` returns whichever provider answered first, so the caller can tell
 * the user where the text came from and — critically — whether it arrived
 * already time-synced. Synced text is plain LRC (`[mm:ss.xx] line`), which the
 * client's existing "keep timestamps" import path already parses.
 */
export type LyricsProviderName = 'lrclib' | 'lyricfind' | 'lyricsovh';

export type LyricsResult = {
  /** Plain text, or LRC when `synced` is true. */
  lyrics: string;
  synced: boolean;
  provider: LyricsProviderName;
};

/** A search hit. `thumbnail`/`url` are Genius-only; LRCLIB has neither. */
export type LyricsSearchHit = {
  /** Namespaced so `extract` can resolve a hit back to its provider exactly. */
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  /** Track length in seconds, when the provider reports it. */
  duration?: number | null;
  /** True when this hit is known to carry timestamped lyrics. */
  synced?: boolean;
  thumbnail?: string | null;
  url?: string | null;
  provider: LyricsProviderName | 'genius';
};
