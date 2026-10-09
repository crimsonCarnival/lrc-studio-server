import Project from '../projects/project.model.js';
import Lyrics from '../lyrics/lyrics.model.js';
import Playlist from '../../db/playlist.model.js';
import User from '../../db/user.model.js';
import { getEnv } from '../../config/env.js';
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_TYPE,
  OG_IMAGE_WIDTH,
  getDefaultOgImageUrl,
} from './og.image.service.js';
import {
  OG_LOCALE_CODE,
  SITE_NAME,
  alternateLocaleCodes,
  getOgStrings,
  interpolate,
  type OgLocale,
} from './og.strings.js';

/**
 * Resolved metadata for one client route. The Vercel routing middleware is
 * coded against this exact shape — treat it as a published contract and only
 * extend it additively.
 */
export type OgMetaImage = {
  url: string;
  secureUrl: string;
  type: string;
  width: number;
  height: number;
  alt: string;
};

export type OgMeta = {
  type: 'website' | 'music.song' | 'profile' | 'article';
  title: string;
  description: string;
  /** Absolute https URL on the client origin. */
  canonical: string;
  siteName: string;
  locale: string;
  localeAlternate: string[];
  robots: string;
  themeColor: string;
  image: OgMetaImage;
  music?: { musician?: string };
  profile?: { username?: string };
};

export const ROBOTS_INDEX = 'index,follow';
export const ROBOTS_NOINDEX = 'noindex,nofollow';

/**
 * ASSUMPTION: the brand theme colour is the dark theme page background, the
 * same value `modules/email/email-themes.ts` uses for `dark.bg`. Duplicated
 * rather than imported so the OG surface does not depend on the email module.
 */
const THEME_COLOR = '#09090b';

/** og:description budget. Facebook/X truncate past roughly this. */
export const DESCRIPTION_MAX = 150;

/** Lyric lines are not an unbounded read — only the opening of the song is used. */
const LYRIC_LINES_SAMPLED = 12;

/** en dash, per the song/artist title format. */
const TITLE_SEPARATOR = '–';

export function getClientOrigin(): string {
  const env = getEnv();
  return (env.CLIENT_ORIGIN || env.APP_URL || '').replace(/\/+$/, '');
}

/**
 * Collapses whitespace and cuts to at most `max` characters (ellipsis
 * included) on a word boundary. A single token longer than the budget is the
 * only case that splits mid-word — overflowing the cap would be worse, since
 * crawlers hard-truncate and the result is what users actually see.
 */
export function truncateAtWord(text: string, max = DESCRIPTION_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;

  let out = '';
  for (const word of clean.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    // +1 reserves room for the ellipsis so the total never exceeds `max`.
    if (next.length + 1 > max) break;
    out = next;
  }
  if (!out) out = clean.slice(0, max - 1);

  return `${out.replace(/[\s,;:.!?–—-]+$/u, '')}…`;
}

function brandImage(locale: OgLocale): OgMetaImage {
  const url = getDefaultOgImageUrl();
  return {
    url,
    secureUrl: url,
    type: OG_IMAGE_TYPE,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    alt: getOgStrings(locale).defaultImageAlt,
  };
}

function resourceImage(url: string, title: string, locale: OgLocale): OgMetaImage {
  return {
    url,
    secureUrl: url,
    type: OG_IMAGE_TYPE,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    alt: interpolate(getOgStrings(locale).resourceImageAlt, { title }),
  };
}

function baseMeta(locale: OgLocale): Pick<OgMeta, 'siteName' | 'locale' | 'localeAlternate' | 'themeColor'> {
  return {
    siteName: SITE_NAME,
    locale: OG_LOCALE_CODE[locale],
    localeAlternate: alternateLocaleCodes(locale),
    themeColor: THEME_COLOR,
  };
}

/**
 * The single payload returned for every resource that is not publicly
 * visible — non-existent, `public: false`, `isPublic: false`, owned by a
 * banned/shadow-banned/deleted user, or a path we do not recognise.
 *
 * It is a pure function of the locale: nothing about the request path or the
 * resource reaches it, which is what makes a private project and a
 * non-existent one byte-identical. Do not thread the requested path into the
 * canonical here — a path-derived canonical is still identical between those
 * two cases, but it is one more field a future change could make conditional.
 */
export function buildHiddenMeta(locale: OgLocale): OgMeta {
  const strings = getOgStrings(locale);
  return {
    type: 'website',
    title: strings.genericTitle,
    description: strings.genericDescription,
    canonical: `${getClientOrigin()}/`,
    ...baseMeta(locale),
    robots: ROBOTS_NOINDEX,
    image: brandImage(locale),
  };
}

function buildBrandedMeta(
  locale: OgLocale,
  title: string,
  description: string,
  path: string,
): OgMeta {
  return {
    type: 'website',
    title,
    description,
    canonical: `${getClientOrigin()}${path}`,
    ...baseMeta(locale),
    robots: ROBOTS_INDEX,
    image: brandImage(locale),
  };
}

export type ParsedOgRoute =
  | { kind: 'home' }
  | { kind: 'explore' }
  | { kind: 'leaderboard' }
  | { kind: 'project'; publicId: string }
  | { kind: 'profile'; accountName: string }
  | { kind: 'list'; accountName: string; listId: string }
  | { kind: 'unknown' };

/** nanoid(10) — the alphabet Project.publicId is generated from. */
const PUBLIC_ID = /^[A-Za-z0-9_-]{1,32}$/;
const ACCOUNT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const OBJECT_ID = /^[a-f\d]{24}$/i;

/**
 * Maps a client SPA path onto a resource. The `path` query parameter is
 * attacker-controlled, so every captured segment is shape-validated before it
 * reaches a Mongo query — an unvalidated segment in a `findOne` filter is how
 * an object-shaped value becomes a query operator.
 */
export function parseClientPath(rawPath: string | null | undefined): ParsedOgRoute {
  if (typeof rawPath !== 'string') return { kind: 'unknown' };

  // Tolerate a full URL as well as a bare path; take the path only.
  let pathname = rawPath;
  if (/^https?:\/\//i.test(rawPath)) {
    try {
      pathname = new URL(rawPath).pathname;
    } catch {
      return { kind: 'unknown' };
    }
  }

  pathname = pathname.split('?')[0].split('#')[0];
  if (!pathname.startsWith('/')) return { kind: 'unknown' };
  if (pathname.length > 512) return { kind: 'unknown' };
  // Control characters (CR/LF above all) must never reach a header or a filter.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pathname)) return { kind: 'unknown' };

  let segments: string[];
  try {
    segments = pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  } catch {
    return { kind: 'unknown' };
  }

  if (segments.length === 0) return { kind: 'home' };

  const [first, second, third, fourth] = segments;

  if (segments.length === 1) {
    if (first === 'explore') return { kind: 'explore' };
    if (first === 'leaderboard') return { kind: 'leaderboard' };
    return { kind: 'unknown' };
  }

  if (first === 'project' && segments.length === 2 && PUBLIC_ID.test(second)) {
    return { kind: 'project', publicId: second };
  }

  if (first === 'profile' && segments.length === 2 && ACCOUNT_NAME.test(second)) {
    return { kind: 'profile', accountName: second };
  }

  if (
    first === 'profile'
    && segments.length === 4
    && third === 'lists'
    && ACCOUNT_NAME.test(second)
    && OBJECT_ID.test(fourth)
  ) {
    return { kind: 'list', accountName: second, listId: fourth };
  }

  return { kind: 'unknown' };
}

function ogImageEndpoint(apiOrigin: string, type: 'project' | 'profile' | 'list', id: string): string {
  return `${apiOrigin.replace(/\/+$/, '')}/og/image/${type}/${encodeURIComponent(id)}.png`;
}

export type ProjectMetaInput = {
  publicId: string;
  title?: string | null;
  description?: string | null;
  songName?: string | null;
  songArtist?: string | null;
  lyricLines: string[];
};

/** Pure builder — kept separate from the DB read so it is directly testable. */
export function buildProjectMeta(
  input: ProjectMetaInput,
  locale: OgLocale,
  apiOrigin: string,
): OgMeta {
  const strings = getOgStrings(locale);
  const song = (input.songName || input.title || '').trim();
  const artist = (input.songArtist || '').trim();
  const subject = song || SITE_NAME;

  const title = artist
    ? `${subject} ${TITLE_SEPARATOR} ${artist}${strings.titleSuffix}`
    : `${subject}${strings.titleSuffix}`;

  const lyricSample = input.lyricLines
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, LYRIC_LINES_SAMPLED)
    .join(' ');

  const source = lyricSample || (input.description || '').trim() || strings.projectFallbackDescription;

  const meta: OgMeta = {
    type: artist ? 'music.song' : 'article',
    title,
    description: truncateAtWord(source),
    canonical: `${getClientOrigin()}/project/${input.publicId}`,
    ...baseMeta(locale),
    robots: ROBOTS_INDEX,
    image: resourceImage(ogImageEndpoint(apiOrigin, 'project', input.publicId), subject, locale),
  };

  if (artist) meta.music = { musician: artist };
  return meta;
}

export type ProfileMetaInput = {
  accountName: string;
  displayName?: string | null;
  bio?: string | null;
};

export function buildProfileMeta(
  input: ProfileMetaInput,
  locale: OgLocale,
  apiOrigin: string,
): OgMeta {
  const strings = getOgStrings(locale);
  const name = (input.displayName || '').trim() || input.accountName;
  // ASSUMPTION: profile titles read "<display name> (@account) — LRC Studio".
  // The spec only fixed the project title format; this keeps the handle
  // visible, which is what makes a shared profile link identifiable.
  const title = `${name} (@${input.accountName})${strings.titleSuffix}`;
  const bio = (input.bio || '').trim();

  return {
    type: 'profile',
    title,
    description: bio
      ? truncateAtWord(bio)
      : truncateAtWord(interpolate(strings.profileFallbackDescription, { name })),
    canonical: `${getClientOrigin()}/profile/${input.accountName}`,
    ...baseMeta(locale),
    robots: ROBOTS_INDEX,
    image: resourceImage(ogImageEndpoint(apiOrigin, 'profile', input.accountName), name, locale),
    profile: { username: input.accountName },
  };
}

export type ListMetaInput = {
  listId: string;
  accountName: string;
  name: string;
  description?: string | null;
};

export function buildListMeta(
  input: ListMetaInput,
  locale: OgLocale,
  apiOrigin: string,
): OgMeta {
  const strings = getOgStrings(locale);
  const name = input.name.trim() || SITE_NAME;
  const description = (input.description || '').trim();

  return {
    // ASSUMPTION: a playlist is an `article`, not a `music.playlist`. The
    // music.* types are part of the deprecated OG music namespace and X/Slack
    // ignore them; `article` degrades to a large summary card everywhere.
    type: 'article',
    title: `${name}${strings.titleSuffix}`,
    description: truncateAtWord(description || strings.listFallbackDescription),
    canonical: `${getClientOrigin()}/profile/${input.accountName}/lists/${input.listId}`,
    ...baseMeta(locale),
    robots: ROBOTS_INDEX,
    image: resourceImage(ogImageEndpoint(apiOrigin, 'list', input.listId), name, locale),
  };
}

/**
 * True when a user is visible to an anonymous visitor. Matches the
 * `publicProfile` resolver's gate (`isDeleted` / `ban.active`) and adds
 * `shadowBan.search`, because a social card IS a search surface — a
 * shadow-banned profile that is hidden from `/explore` and user search should
 * not be resurfaced by a crawler preview.
 */
function isUserPubliclyVisible(user: {
  isDeleted?: boolean;
  ban?: { active?: boolean };
  shadowBan?: { search?: boolean };
} | null): boolean {
  if (!user) return false;
  if (user.isDeleted) return false;
  if (user.ban?.active) return false;
  if (user.shadowBan?.search) return false;
  return true;
}

async function resolveProject(
  publicId: string,
  locale: OgLocale,
  apiOrigin: string,
): Promise<OgMeta> {
  const project = await Project.findOne({ publicId, public: true })
    .select('publicId title description metadata userId')
    .lean<{
      publicId: string;
      title?: string;
      description?: string;
      metadata?: { songName?: string; songArtist?: string };
      userId?: unknown;
    }>();

  if (!project) return buildHiddenMeta(locale);

  // A project whose owner is banned/deleted/shadow-banned is not a public
  // surface either — the owner's own profile card is hidden, so their project
  // cards must be too, or the ban is trivially bypassed by sharing a project.
  if (project.userId) {
    const owner = await User.findById(project.userId)
      .select('isDeleted ban.active shadowBan.search')
      .lean<{ isDeleted?: boolean; ban?: { active?: boolean }; shadowBan?: { search?: boolean } }>();
    if (!isUserPubliclyVisible(owner)) return buildHiddenMeta(locale);
  }

  const lyrics = await Lyrics.findOne({ publicId })
    .select('sections')
    .lean<{ sections?: { lines?: { text?: string }[] }[] }>();

  const lyricLines: string[] = [];
  for (const section of lyrics?.sections ?? []) {
    for (const line of section.lines ?? []) {
      if (typeof line.text === 'string' && line.text.trim()) lyricLines.push(line.text);
      if (lyricLines.length >= LYRIC_LINES_SAMPLED) break;
    }
    if (lyricLines.length >= LYRIC_LINES_SAMPLED) break;
  }

  return buildProjectMeta(
    {
      publicId: project.publicId,
      title: project.title,
      description: project.description,
      songName: project.metadata?.songName,
      songArtist: project.metadata?.songArtist,
      lyricLines,
    },
    locale,
    apiOrigin,
  );
}

async function resolveProfile(
  accountName: string,
  locale: OgLocale,
  apiOrigin: string,
): Promise<OgMeta> {
  const user = await User.findOne({ accountName: accountName.toLowerCase() })
    .select('accountName displayName bio isDeleted ban.active shadowBan.search')
    .lean<{
      accountName?: string;
      displayName?: string | null;
      bio?: string;
      isDeleted?: boolean;
      ban?: { active?: boolean };
      shadowBan?: { search?: boolean };
    }>();

  if (!isUserPubliclyVisible(user) || !user?.accountName) return buildHiddenMeta(locale);

  return buildProfileMeta(
    { accountName: user.accountName, displayName: user.displayName, bio: user.bio },
    locale,
    apiOrigin,
  );
}

async function resolveList(
  accountName: string,
  listId: string,
  locale: OgLocale,
  apiOrigin: string,
): Promise<OgMeta> {
  const playlist = await Playlist.findOne({ _id: listId, isPublic: true })
    .select('name description userId isPublic')
    .lean<{ name?: string; description?: string; userId?: unknown }>();

  if (!playlist?.name) return buildHiddenMeta(locale);

  const owner = await User.findById(playlist.userId)
    .select('accountName isDeleted ban.active shadowBan.search')
    .lean<{
      accountName?: string;
      isDeleted?: boolean;
      ban?: { active?: boolean };
      shadowBan?: { search?: boolean };
    }>();

  if (!isUserPubliclyVisible(owner)) return buildHiddenMeta(locale);
  // The path must actually belong to the owner; otherwise any account name
  // could be used to address any public playlist.
  if (owner?.accountName !== accountName.toLowerCase()) return buildHiddenMeta(locale);

  return buildListMeta(
    { listId, accountName: owner.accountName, name: playlist.name, description: playlist.description },
    locale,
    apiOrigin,
  );
}

/**
 * Resolves a client path to OG metadata. Never throws and never rejects —
 * every failure path, including a dropped Mongo connection, degrades to the
 * hidden/generic payload so the crawler always gets valid JSON.
 */
export async function resolveOgMeta(params: {
  path: string | null | undefined;
  locale: OgLocale;
  apiOrigin: string;
}): Promise<OgMeta> {
  const { path, locale, apiOrigin } = params;
  const route = parseClientPath(path);
  const strings = getOgStrings(locale);

  try {
    switch (route.kind) {
      case 'home':
        return buildBrandedMeta(locale, strings.homeTitle, strings.homeDescription, '/');
      case 'explore':
        return buildBrandedMeta(locale, strings.exploreTitle, strings.exploreDescription, '/explore');
      case 'leaderboard':
        return buildBrandedMeta(locale, strings.leaderboardTitle, strings.leaderboardDescription, '/leaderboard');
      case 'project':
        return await resolveProject(route.publicId, locale, apiOrigin);
      case 'profile':
        return await resolveProfile(route.accountName, locale, apiOrigin);
      case 'list':
        return await resolveList(route.accountName, route.listId, locale, apiOrigin);
      default:
        // ASSUMPTION: an unrecognised path gets the generic payload with
        // `noindex,nofollow` rather than `index,follow`. The spec says
        // "generic website payload" without pinning robots; a client route we
        // do not know about is, as far as this server can tell, not a page,
        // and inviting a crawler to index arbitrary SPA 404s is the worse
        // default. Flip the default case to buildBrandedMeta if the SEO team
        // wants unknown routes indexable.
        return buildHiddenMeta(locale);
    }
  } catch {
    return buildHiddenMeta(locale);
  }
}

export type OgCardType = 'project' | 'profile' | 'list';

export function isValidCardId(type: OgCardType, id: string): boolean {
  if (type === 'project') return PUBLIC_ID.test(id);
  if (type === 'profile') return ACCOUNT_NAME.test(id);
  return OBJECT_ID.test(id);
}

/**
 * The Cloudinary asset backing a resource's social card, or `null` when the
 * resource is missing, not public, or owned by a hidden user. The caller
 * cannot distinguish those cases — all three mean "serve the brand card".
 *
 * Lives here, next to `isUserPubliclyVisible`, so the visibility rules for the
 * JSON surface and the image surface cannot drift apart.
 */
export async function resolveCardSourceUrl(type: OgCardType, id: string): Promise<string | null> {
  if (!isValidCardId(type, id)) return null;

  try {
    if (type === 'project') {
      const project = await Project.findOne({ publicId: id, public: true })
        .select('coverImage userId')
        .lean<{ coverImage?: string; userId?: unknown }>();
      if (!project) return null;
      if (project.userId) {
        const owner = await User.findById(project.userId)
          .select('isDeleted ban.active shadowBan.search')
          .lean<{ isDeleted?: boolean; ban?: { active?: boolean }; shadowBan?: { search?: boolean } }>();
        if (!isUserPubliclyVisible(owner)) return null;
      }
      return project.coverImage || null;
    }

    if (type === 'profile') {
      const user = await User.findOne({ accountName: id.toLowerCase() })
        .select('avatarUrl isDeleted ban.active shadowBan.search')
        .lean<{
          avatarUrl?: string | null;
          isDeleted?: boolean;
          ban?: { active?: boolean };
          shadowBan?: { search?: boolean };
        }>();
      if (!isUserPubliclyVisible(user)) return null;
      return user?.avatarUrl || null;
    }

    const playlist = await Playlist.findOne({ _id: id, isPublic: true })
      .select('coverImage userId')
      .lean<{ coverImage?: string; userId?: unknown }>();
    if (!playlist) return null;
    const owner = await User.findById(playlist.userId)
      .select('isDeleted ban.active shadowBan.search')
      .lean<{ isDeleted?: boolean; ban?: { active?: boolean }; shadowBan?: { search?: boolean } }>();
    if (!isUserPubliclyVisible(owner)) return null;
    return playlist.coverImage || null;
  } catch {
    return null;
  }
}
