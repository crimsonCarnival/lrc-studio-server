/**
 * Readable project URL slugs. The algorithm mirrors the web client
 * (`src/features/projects/project-path.ts`) and must stay byte-identical to it.
 *
 * The slug in a URL is cosmetic: projects are always resolved by `publicId`
 * (the last 10 characters of the final path segment), so a stale slug or
 * account name never breaks a link.
 */

const MAX_SLUG_LENGTH = 60;

export function slugify(input: string): string {
  let s = input.normalize('NFD');
  // Latin diacritics only (U+0300–U+036F). Kana dakuten U+3099/U+309A are left
  // alone so が does not decay into か.
  s = s.replace(/[\u0300-\u036f]/g, '');
  s = s.normalize('NFC').toLowerCase();
  s = s.replace(/['’]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.slice(0, MAX_SLUG_LENGTH);
  // A cut can land between the halves of a surrogate pair, which would make
  // encodeURIComponent throw on the resulting path.
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
  return s.replace(/-+$/g, '');
}

type SlugMetadata = {
  songName?: string | null;
  songArtist?: string | null;
  songArtists?: (string | null)[] | null;
};

export interface SlugSource {
  title?: string | null;
  /** Any metadata-shaped object; only songName / songArtist(s) are read. */
  metadata?: object | null;
}

export function projectSlug(p: SlugSource): string {
  const m = (p.metadata ?? {}) as SlugMetadata;
  const artist = m.songArtist || m.songArtists?.[0] || '';
  const songName = m.songName || '';
  return slugify(`${artist} ${songName}`) || slugify(p.title || '') || '';
}

export interface PathSource extends SlugSource {
  publicId: string;
  slug?: string | null;
}

/** Canonical web path for a project. Prefers the stored slug over recomputing. */
export function projectPath(p: PathSource, ownerAccountName: string | null | undefined): string {
  const slug = p.slug || projectSlug(p);
  const segment = slug ? `${slug}-${p.publicId}` : p.publicId;
  if (!ownerAccountName) return `/project/${encodeURIComponent(p.publicId)}`;
  return `/${encodeURIComponent(ownerAccountName)}/projects/${encodeURIComponent(segment)}`;
}
