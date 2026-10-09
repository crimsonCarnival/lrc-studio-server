export interface Env {
  PORT: number;
  HOST: string;
  NODE_ENV: 'development' | 'production' | 'test';
  MONGODB_URI: string;
  JWT_SECRET: string;
  COOKIE_SECRET: string;
  JWT_ACCESS_EXPIRY: string;
  JWT_REFRESH_EXPIRY: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  CORS_ORIGIN: string;
  /**
   * Parent domain for auth cookies, e.g. `.lrcstudio.app`. Set this only when
   * more than one hostname of the same site must share a session (www + m +
   * admin). Leaving it unset keeps cookies host-only, which is the tighter
   * default: a host-only cookie is never sent to a sibling subdomain, so a
   * takeover of one subdomain cannot replay the session on another.
   */
  COOKIE_DOMAIN?: string;
  APP_URL: string;
  APP_URLS: string[];
  PASSWORD_RESET_URL: string;
  RATE_LIMIT_MAX: number;
  RATE_LIMIT_WINDOW_MS: number;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  GENIUS_CLIENT_ACCESS_TOKEN?: string;
  /**
   * LyricFind is a licensed commercial API — no key means the provider is
   * skipped entirely and the lyrics chain falls through to lyrics.ovh.
   * See modules/genius/lyricfind.service.ts. LRCLIB (the primary provider)
   * needs no configuration at all.
   */
  LYRICFIND_API_KEY?: string;
  /** Display territory for LyricFind licensing checks. Defaults to 'US'. */
  LYRICFIND_TERRITORY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  TRACK_METADATA_CLIENT_ID?: string;
  TRACK_METADATA_CLIENT_SECRET?: string;
  LASTFM_API_KEY?: string;
  /**
   * Email address to auto-grant the `superadmin` role to (case-insensitive
   * exact match, no wildcards). See modules/auth/superadmin-env.service.ts.
   * Unset/empty is a no-op — never accidentally grants to nobody/everybody.
   */
  SUPERADMIN_EMAIL?: string;
  /**
   * Absolute URL of the 1200x630 brand card the OG image endpoints fall back
   * to for a missing, private or non-Cloudinary asset. The asset itself lives
   * in the client repo's `public/`, so the default points at the production
   * client origin.
   */
  OG_DEFAULT_IMAGE_URL: string;
  /**
   * Absolute origin of THIS api, used to build the `og:image` URLs that point
   * back at `/og/image/...`. Unset falls back to the origin the request
   * arrived on (`trustProxy` is enabled), which is correct in every
   * single-origin deployment.
   */
  OG_API_ORIGIN?: string;
  /**
   * Absolute origin of the client SPA, used for `og:url` / canonical. Unset
   * falls back to APP_URL.
   */
  CLIENT_ORIGIN?: string;
}

function requireEnv(name: string, value: string | undefined, requiredInProduction = false): string | undefined {
  if (!value && process.env.NODE_ENV !== 'development' && requiredInProduction) {
    throw new Error(`FATAL: ${name} must be set in production.`);
  }
  return value;
}

export function loadEnv(): Env {
  const corsOrigin = requireEnv('CORS_ORIGIN', process.env.CORS_ORIGIN, true) ?? 'http://localhost:5173';
  const appUrlString = process.env.APP_URL ?? corsOrigin;
  const appUrls = appUrlString
    .split(',')
    .map(url => url.trim())
    .filter(url => url.length > 0);
  const primaryAppUrl = appUrls[appUrls.length - 1] || corsOrigin;

  return {
    PORT: parseInt(process.env.PORT ?? '3000', 10),
    HOST: process.env.HOST ?? '0.0.0.0',
    NODE_ENV: (process.env.NODE_ENV as Env['NODE_ENV']) ?? 'production',
    MONGODB_URI: requireEnv('MONGODB_URI', process.env.MONGODB_URI, true) ?? 'mongodb://localhost:27017/lrc-studio',
    JWT_SECRET: requireEnv('JWT_SECRET', process.env.JWT_SECRET, true) ?? 'dev-jwt-secret',
    COOKIE_SECRET: requireEnv('COOKIE_SECRET', process.env.COOKIE_SECRET, true) ?? 'dev-cookie-secret',
    JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY ?? '15m',
    JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY ?? '30d',
    JWT_ISSUER: process.env.JWT_ISSUER,
    JWT_AUDIENCE: process.env.JWT_AUDIENCE,
    CORS_ORIGIN: corsOrigin,
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
    APP_URL: primaryAppUrl,
    APP_URLS: appUrls,
    PASSWORD_RESET_URL: process.env.PASSWORD_RESET_URL ?? primaryAppUrl,
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX ?? '200', 10),
    RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
    GENIUS_CLIENT_ACCESS_TOKEN: process.env.GENIUS_CLIENT_ACCESS_TOKEN,
    LYRICFIND_API_KEY: process.env.LYRICFIND_API_KEY,
    LYRICFIND_TERRITORY: process.env.LYRICFIND_TERRITORY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    TRACK_METADATA_CLIENT_ID: process.env.TRACK_METADATA_CLIENT_ID,
    TRACK_METADATA_CLIENT_SECRET: process.env.TRACK_METADATA_CLIENT_SECRET,
    LASTFM_API_KEY: process.env.LASTFM_API_KEY,
    SUPERADMIN_EMAIL: process.env.SUPERADMIN_EMAIL,
    OG_DEFAULT_IMAGE_URL: process.env.OG_DEFAULT_IMAGE_URL?.trim() || 'https://www.lrcstudio.app/og-default.png',
    OG_API_ORIGIN: process.env.OG_API_ORIGIN?.trim() || undefined,
    CLIENT_ORIGIN: process.env.CLIENT_ORIGIN?.trim() || undefined,
  };
}

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = loadEnv();
  }
  return _env;
}