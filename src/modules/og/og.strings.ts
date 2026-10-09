/**
 * Static fallback copy for the Open Graph surfaces, in the two locales the
 * client actually ships (`client/src/locales/en` and `.../es`).
 *
 * Deliberately NOT i18next. `i18next` is listed in package.json but is
 * imported nowhere in `src/` — wiring it into Fastify (backend plugin,
 * resource bundles, per-request instance) to serve ~10 constant strings in
 * 2 locales would add a request-scoped dependency and a second translation
 * source of truth for no behavioural gain. A typed record gives compile-time
 * completeness checking (a missing key in `es` is a type error), which the
 * runtime-keyed i18next API does not.
 */

export type OgLocale = 'en' | 'es';

/** OG `og:locale` codes. en → en_US, es → es_CO (the client's primary markets). */
export const OG_LOCALE_CODE: Record<OgLocale, string> = {
  en: 'en_US',
  es: 'es_CO',
};

export const OG_LOCALES: readonly OgLocale[] = ['en', 'es'] as const;

export type OgStrings = {
  /** Appended to every resource title. */
  titleSuffix: string;
  genericTitle: string;
  genericDescription: string;
  homeTitle: string;
  homeDescription: string;
  exploreTitle: string;
  exploreDescription: string;
  leaderboardTitle: string;
  leaderboardDescription: string;
  /** Used when a project has neither lyrics nor a description. */
  projectFallbackDescription: string;
  /** Used when a profile has no bio. `{name}` is substituted. */
  profileFallbackDescription: string;
  /** Used when a playlist has no description. `{name}` is substituted. */
  listFallbackDescription: string;
  /** `og:image:alt` for the brand card. */
  defaultImageAlt: string;
  /** `og:image:alt` for a resource card. `{title}` is substituted. */
  resourceImageAlt: string;
  /** Legacy HTML share page link label. */
  viewOnSite: string;
};

export const SITE_NAME = 'LRC Studio';

const STRINGS: Record<OgLocale, OgStrings> = {
  en: {
    titleSuffix: ' — LRC Studio',
    genericTitle: 'LRC Studio — Sync lyrics to music',
    genericDescription:
      'Create, time and share synced lyrics. Import a song, stamp every line, export LRC, SRT or plain text.',
    homeTitle: 'LRC Studio — Sync lyrics to music',
    homeDescription:
      'Create, time and share synced lyrics. Import a song, stamp every line, export LRC, SRT or plain text.',
    exploreTitle: 'Explore synced lyrics — LRC Studio',
    exploreDescription:
      'Discover trending synced lyric projects and playlists from the LRC Studio community.',
    leaderboardTitle: 'Leaderboard — LRC Studio',
    leaderboardDescription:
      'See who has synced the most lines, earned the most stars and climbed highest on LRC Studio.',
    projectFallbackDescription: 'Synced lyrics made with LRC Studio.',
    profileFallbackDescription: '{name} on LRC Studio — synced lyric projects, playlists and badges.',
    listFallbackDescription: 'A playlist of synced lyric projects on LRC Studio.',
    defaultImageAlt: 'LRC Studio',
    resourceImageAlt: '{title} on LRC Studio',
    viewOnSite: 'View on LRC Studio',
  },
  es: {
    titleSuffix: ' — LRC Studio',
    genericTitle: 'LRC Studio — Sincroniza letras con la música',
    genericDescription:
      'Crea, cronometra y comparte letras sincronizadas. Importa una canción, marca cada línea y exporta LRC, SRT o texto.',
    homeTitle: 'LRC Studio — Sincroniza letras con la música',
    homeDescription:
      'Crea, cronometra y comparte letras sincronizadas. Importa una canción, marca cada línea y exporta LRC, SRT o texto.',
    exploreTitle: 'Explorar letras sincronizadas — LRC Studio',
    exploreDescription:
      'Descubre proyectos y listas de letras sincronizadas en tendencia de la comunidad de LRC Studio.',
    leaderboardTitle: 'Clasificación — LRC Studio',
    leaderboardDescription:
      'Mira quién ha sincronizado más líneas, recibido más estrellas y llegado más alto en LRC Studio.',
    projectFallbackDescription: 'Letras sincronizadas hechas con LRC Studio.',
    profileFallbackDescription: '{name} en LRC Studio — proyectos de letras sincronizadas, listas e insignias.',
    listFallbackDescription: 'Una lista de proyectos de letras sincronizadas en LRC Studio.',
    defaultImageAlt: 'LRC Studio',
    resourceImageAlt: '{title} en LRC Studio',
    viewOnSite: 'Ver en LRC Studio',
  },
};

export function getOgStrings(locale: OgLocale): OgStrings {
  return STRINGS[locale];
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? '');
}

function normalizeTag(tag: string): OgLocale | null {
  const base = tag.trim().toLowerCase().split('-')[0];
  return (OG_LOCALES as readonly string[]).includes(base) ? (base as OgLocale) : null;
}

/**
 * Locale resolution order: `?hl=` first (the client uses the same querystring
 * key), then `Accept-Language` by q-value, then `en`.
 */
export function resolveLocale(hl?: string | null, acceptLanguage?: string | null): OgLocale {
  if (typeof hl === 'string' && hl) {
    const fromQuery = normalizeTag(hl);
    if (fromQuery) return fromQuery;
  }

  if (typeof acceptLanguage === 'string' && acceptLanguage) {
    const ranked = acceptLanguage
      .split(',')
      .map((part, index) => {
        const [tag, ...params] = part.split(';');
        const qParam = params.find(p => p.trim().startsWith('q='));
        const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
        return { tag, q: Number.isFinite(q) ? q : 0, index };
      })
      .filter(entry => entry.q > 0)
      .sort((a, b) => (b.q - a.q) || (a.index - b.index));

    for (const entry of ranked) {
      const match = normalizeTag(entry.tag);
      if (match) return match;
    }
  }

  return 'en';
}

export function alternateLocaleCodes(locale: OgLocale): string[] {
  return OG_LOCALES.filter(l => l !== locale).map(l => OG_LOCALE_CODE[l]);
}
