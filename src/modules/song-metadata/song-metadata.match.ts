/**
 * Ranking for track lookups. Providers rank by popularity, so their first hit for
 * "castles Lil Peep" can be another artist's bigger "Castles". Everything here is pure:
 * the service gathers candidates from every provider and this decides which ones
 * actually are the song the user described, best first.
 */

export type TrackProvider = 'spotify' | 'itunes' | 'deezer';

export interface TrackCandidate {
  provider: TrackProvider;
  trackId: string;
  name: string;
  /** Every credited artist, joined with ", " (the provider's own credits). */
  artist: string;
  album: string;
  duration: number;
  albumArt: string | null;
  releaseYear: string | null;
  totalTracks: number | null;
  trackNumber: number | null;
  previewUrl: string | null;
  explicit: boolean;
  genres: string[];
}

export interface TrackQuery {
  songName: string;
  /** The primary artists as one string ("A & B"), as the client joins them. */
  artistName?: string;
  featuredArtists?: string[];
}

export interface RankedCandidate extends TrackCandidate {
  /** 0–100; only comparable within one search. */
  score: number;
  /** A requested primary artist is credited on the track. */
  artistMatch: boolean;
  /** Every requested featured artist is credited (in the artists or the title). */
  featuredMatch: boolean;
  /** The title is the requested one, ignoring "(feat. …)", "- Remastered" and the like. */
  titleMatch: boolean;
}

/** Lowercase, no accents, punctuation to spaces, "&"/"+" to "and", single spaces. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Bracketed or dashed tails that name a variant, not a different song.
const BRACKETS = /\s*[([{][^)\]}]*[)\]}]/g;
const DASH_TAIL = /\s+[-–—]\s+.*$/;

/** The title without "(feat. X)", "[Remix]", " - Remastered 2011". */
export function baseTitle(title: string): string {
  return normalize(title.replace(BRACKETS, ' ').replace(DASH_TAIL, ''));
}

// Words that mark a different recording of the song. Penalised unless the user typed them too.
const VARIANT_WORDS = [
  'remix', 'rmx', 'sped up', 'speed up', 'slowed', 'reverb', 'nightcore', 'live', 'acoustic',
  'instrumental', 'karaoke', 'cover', 'tribute', 'acapella', 'a cappella', 'demo', '8d', 'lofi', 'lo fi', 'bootleg', 'mashup', 'edit',
];

function variantWords(title: string): string[] {
  const n = ` ${normalize(title)} `;
  return VARIANT_WORDS.filter((w) => n.includes(` ${w} `));
}

/** Splits "A & B", "A, B", "A x B", "A feat. B" into names. "and" is left alone: "Florence and the Machine". */
export function splitArtists(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\+|;|\/|\s[x×]\s|\bfeat\.?\s|\bft\.?\s|\bfeaturing\s|\bwith\s)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Whole-word containment on normalized text, so "lil peep" is in "lil peep and lil tracy" but "peep" is not "peeps". */
function containsName(haystack: string, name: string): boolean {
  const n = normalize(name);
  if (!n) return false;
  return ` ${haystack} `.includes(` ${n} `);
}

/** True when the requested artist (whole, or any of its parts) is credited in `credited`. */
function artistCredited(credited: string, requested: string): boolean {
  if (containsName(credited, requested)) return true;
  // Spacing/punctuation variants: "LILPEEP" vs "Lil Peep", "Tyler, The Creator" vs "Tyler The Creator".
  const squash = (s: string) => normalize(s).replace(/\s/g, '');
  const parts = splitArtists(requested);
  return parts.some((p) => containsName(credited, p) || (squash(p).length >= 4 && credited.replace(/\s/g, '').includes(squash(p))));
}

const PROVIDER_ORDER: Record<TrackProvider, number> = { spotify: 0, itunes: 1, deezer: 2 };

export function scoreCandidate(c: TrackCandidate, q: TrackQuery): RankedCandidate {
  // Featured artists often live only in the title ("Castles (feat. Lil Tracy)").
  const credited = normalize(c.artist);
  const creditedAndTitle = `${credited} ${normalize(c.name)}`;

  const requestedArtist = q.artistName?.trim() ?? '';
  const artistMatch = !requestedArtist || artistCredited(credited, requestedArtist);

  const featured = (q.featuredArtists ?? []).map((f) => f.trim()).filter(Boolean);
  const featuredHits = featured.filter((f) => artistCredited(creditedAndTitle, f)).length;
  const featuredMatch = featured.length > 0 && featuredHits === featured.length;

  const wantedFull = normalize(q.songName);
  const wantedBase = baseTitle(q.songName) || wantedFull;
  const gotFull = normalize(c.name);
  const gotBase = baseTitle(c.name) || gotFull;
  const titleMatch = gotBase === wantedBase;

  let score = 0;
  if (artistMatch) score += 50;
  if (gotFull === wantedFull) score += 30;
  else if (titleMatch) score += 24;
  else if (gotBase.includes(wantedBase) || wantedBase.includes(gotBase)) score += 10;
  if (featured.length > 0) score += Math.round((featuredHits / featured.length) * 15);

  // A version the user didn't ask for (remix, sped up, live…) is a different recording.
  const asked = new Set(variantWords(q.songName));
  const extra = variantWords(c.name).filter((w) => !asked.has(w));
  if (extra.length > 0) score -= 12;

  // Unasked-for guests: "Castles (feat. SNIIMA BEATS)" when the user credited someone else (or no one).
  const titleGuests = /\b(?:feat|ft|featuring|with)\b/i.test(c.name) && featuredHits === 0;
  if (titleGuests) score -= 4;

  if (c.albumArt) score += 1;
  if (c.previewUrl) score += 1;

  return { ...c, score: Math.max(0, Math.min(100, score)), artistMatch, featuredMatch, titleMatch };
}

/** Same song from two providers: same title and same artists, whatever the separators ("A, B" = "A & B"). */
function dedupeKey(c: TrackCandidate): string {
  const artists = normalize(c.artist).split(' ').filter((w) => w !== 'and').sort().join(' ');
  return `${normalize(c.name)}|${artists}`;
}

/** Fill the kept candidate's blanks from a duplicate (Deezer has no genres, iTunes no Spotify art…). */
function mergeInto(keep: RankedCandidate, other: TrackCandidate): void {
  keep.albumArt ??= other.albumArt;
  keep.previewUrl ??= other.previewUrl;
  keep.releaseYear ??= other.releaseYear;
  keep.totalTracks ??= other.totalTracks;
  keep.trackNumber ??= other.trackNumber;
  if (!keep.album) keep.album = other.album;
  if (keep.genres.length === 0) keep.genres = other.genres;
  keep.explicit ||= other.explicit;
}

/**
 * Scores, merges duplicates across providers and sorts best first. Candidates whose artist
 * doesn't match are kept (a misspelt artist still finds the song) but always rank below
 * every match. `limit` caps the list.
 */
export function rankCandidates(candidates: readonly TrackCandidate[], q: TrackQuery, limit = 8): RankedCandidate[] {
  const ranked = candidates.map((c, i) => ({ c: scoreCandidate(c, q), i }));
  ranked.sort((a, b) =>
    Number(b.c.artistMatch) - Number(a.c.artistMatch)
    || b.c.score - a.c.score
    || PROVIDER_ORDER[a.c.provider] - PROVIDER_ORDER[b.c.provider]
    || a.i - b.i);

  const byKey = new Map<string, RankedCandidate>();
  const out: RankedCandidate[] = [];
  for (const { c } of ranked) {
    const key = dedupeKey(c);
    const kept = byKey.get(key);
    if (kept) { mergeInto(kept, c); continue; }
    byKey.set(key, c);
    out.push(c);
  }
  return out.slice(0, limit);
}

/** The single result `/lookup` returns: the best candidate, but only when it is by the requested artist. */
export function bestMatch(ranked: readonly RankedCandidate[]): RankedCandidate | null {
  const top = ranked[0];
  return top && top.artistMatch ? top : null;
}
