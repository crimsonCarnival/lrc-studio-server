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
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  TRACK_METADATA_CLIENT_ID?: string;
  TRACK_METADATA_CLIENT_SECRET?: string;
  LASTFM_API_KEY?: string;
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
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
    TRACK_METADATA_CLIENT_ID: process.env.TRACK_METADATA_CLIENT_ID,
    TRACK_METADATA_CLIENT_SECRET: process.env.TRACK_METADATA_CLIENT_SECRET,
    LASTFM_API_KEY: process.env.LASTFM_API_KEY,
  };
}

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = loadEnv();
  }
  return _env;
}