import { stripHtml } from '../../utils/sanitize.js';
import { projectSlug } from '../../utils/project-slug.js';
import { formatArtistDisplay, validateArtistCredits, type ArtistCredit, type ArtistValidationCode } from '../../utils/artists.js';

export const PROJECT_TITLE_MAX = 200;
export const PROJECT_SONG_NAME_MAX = 500;

/** Used when a project has no title, song name or artist (legacy rows, odd forks). */
export const UNTITLED_FALLBACK = 'untitled';

export const PROJECT_IDENTITY_REQUIRED = {
  error: 'A project needs a title, song name or artist',
  code: 'project_identity_required',
  status: 422,
} as const;

type Meta = Record<string, unknown> | null | undefined;

const clean = (v: unknown, max: number): string =>
  typeof v === 'string' ? stripHtml(v).trim().slice(0, max) : '';

export function cleanTitle(title: unknown): string {
  return clean(title, PROJECT_TITLE_MAX);
}

/** Trims and caps the identity-bearing metadata fields; everything else passes through. */
export function cleanIdentityMetadata(metadata: Meta): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const out: Record<string, unknown> = { ...metadata };
  if ('songName' in out) out.songName = clean(out.songName, PROJECT_SONG_NAME_MAX);
  return out;
}

/** The slug a project would get; also the "is it nameable" test (empty = not). */
export function slugFor(title: unknown, metadata: Meta): string {
  const m = (metadata ?? {}) as { songName?: string; songArtist?: string };
  return projectSlug({ title: typeof title === 'string' ? title : '', metadata: m });
}

export function hasProjectIdentity(title: unknown, metadata: Meta): boolean {
  return slugFor(title, metadata) !== '';
}

/** Title for a row that has no identity at all: upload title, else file name, else "untitled". */
export function fallbackTitle(upload?: { title?: string | null; fileName?: string | null } | null): string {
  const candidate = cleanTitle(upload?.title) || cleanTitle(upload?.fileName);
  return slugFor(candidate, null) ? candidate : UNTITLED_FALLBACK;
}

export type StoredArtistCredit = ArtistCredit & { artistId?: unknown };

export interface ArtistError {
  error: string;
  code: ArtistValidationCode;
  status: 422;
}

/**
 * Resolves the artist fields of a metadata object about to be stored.
 *
 * - `songArtist` is derived, so any value sent for it is discarded.
 * - `artists` present: validated, and `songArtist` becomes its display string.
 *   `[]` clears both. Names have their HTML stripped first.
 * - `artists` absent (an edit that doesn't touch them, or a legacy row): the
 *   stored credits and `songArtist` carry over untouched, since metadata is
 *   replaced wholesale on every update.
 */
export function resolveMetadataArtists(
  metadata: Record<string, unknown>,
  existing: Record<string, unknown> | null | undefined,
): { metadata: Record<string, unknown> } | { failure: ArtistError } {
  const out: Record<string, unknown> = { ...metadata };
  delete out.songArtist;

  const sent = out.artists;
  if (Array.isArray(sent)) {
    const cleaned = sent.map((a) => (a && typeof a === 'object' ? { ...a, name: clean((a as { name?: unknown }).name, 10_000) } : a));
    const result = validateArtistCredits(cleaned);
    if (!result.ok) return { failure: { error: result.message, code: result.code, status: 422 } };
    out.artists = result.credits;
    out.songArtist = formatArtistDisplay(result.credits);
    return { metadata: out };
  }

  const prior = (existing?.artists ?? []) as StoredArtistCredit[];
  const priorPlain = Array.isArray(prior) ? prior.map((c) => ({ ...(c as object) }) as StoredArtistCredit) : [];
  if (priorPlain.length > 0) {
    out.artists = priorPlain;
    out.songArtist = formatArtistDisplay(priorPlain);
  } else {
    delete out.artists;
    if (typeof existing?.songArtist === 'string' && existing.songArtist) out.songArtist = existing.songArtist;
  }
  return { metadata: out };
}
