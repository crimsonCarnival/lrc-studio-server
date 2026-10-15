import { stripHtml } from '../../utils/sanitize.js';
import { projectSlug } from '../../utils/project-slug.js';

export const PROJECT_TITLE_MAX = 200;
export const PROJECT_SONG_NAME_MAX = 500;
export const PROJECT_SONG_ARTIST_MAX = 300;

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
  if ('songArtist' in out) out.songArtist = clean(out.songArtist, PROJECT_SONG_ARTIST_MAX);
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
