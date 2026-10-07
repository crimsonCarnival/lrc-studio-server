import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { isAsrConfigured } from '../asr/groq.client.js';

type CheckStatus = 'ok' | 'degraded' | 'error';

interface ServiceCheck {
  status: CheckStatus;
  responseTime: string;
  message?: string;
}

export interface HealthResponse {
  status: CheckStatus;
  version: string;
  timestamp: string;
  uptime: string;
  environment: string;
  checks: {
    database: ServiceCheck;
    google: ServiceCheck;
    youtube: ServiceCheck;
    lyrics: ServiceCheck;
    cloudinary: ServiceCheck;
    asr: ServiceCheck;
  };
  metrics: {
    memory: { rss: string; heapUsed: string; heapTotal: string; heapUtilization: string };
  };
}

const CACHE_TTL_MS = 30_000;
let cached: HealthResponse | null = null;
let cachedAt = 0;

function ms(start: number): string {
  return `${(performance.now() - start).toFixed(2)}ms`;
}

function toMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function checkDatabase(): Promise<ServiceCheck> {
  const start = performance.now();
  try {
    if (mongoose.connection.readyState !== 1) {
      return { status: 'error', responseTime: ms(start), message: 'not connected' };
    }
    await Promise.race([
      mongoose.connection.db!.command({ ping: 1 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);
    return { status: 'ok', responseTime: ms(start) };
  } catch (err) {
    return { status: 'error', responseTime: ms(start), message: (err as Error).message };
  }
}

function checkConfigured(vars: string[]): ServiceCheck {
  const start = performance.now();
  const allPresent = vars.every((v) => !!process.env[v]);
  return allPresent
    ? { status: 'ok', responseTime: ms(start) }
    : { status: 'degraded', responseTime: ms(start), message: 'not configured' };
}

/**
 * The lyrics provider chain is LRCLIB -> LyricFind -> lyrics.ovh, and LRCLIB
 * (the primary, and the only one returning synced LRC) needs no credentials at
 * all. Lyrics lookup therefore never hard-fails on configuration, so this
 * reports ok and names the optional providers rather than marking the whole
 * service degraded over a key the feature does not require. The previous
 * `genius` check gated on GENIUS_CLIENT_ACCESS_TOKEN, which only affects search.
 */
function checkLyrics(): ServiceCheck {
  const start = performance.now();
  const optional = [
    process.env.GENIUS_CLIENT_ACCESS_TOKEN ? 'genius-search' : null,
    process.env.LYRICFIND_API_KEY ? 'lyricfind' : null,
  ].filter(Boolean);
  return {
    status: 'ok',
    responseTime: ms(start),
    message: `lrclib${optional.length ? `, ${optional.join(', ')}` : ''}`,
  };
}

/** Auto Stamp. Degraded rather than error: the rest of the app works without it. */
function checkAsr(): ServiceCheck {
  const start = performance.now();
  return isAsrConfigured()
    ? { status: 'ok', responseTime: ms(start) }
    : { status: 'degraded', responseTime: ms(start), message: 'GROQ_API_KEY not set' };
}

export async function getHealth(): Promise<HealthResponse> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  const database = await checkDatabase();
  const google = checkConfigured(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const youtube = checkConfigured(['YOUTUBE_API_KEY']);
  const lyrics = checkLyrics();
  const cloudinary = checkConfigured(['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);
  const asr = checkAsr();

  const allChecks = [database, google, youtube, lyrics, cloudinary, asr];
  const status: CheckStatus =
    database.status === 'error'
      ? 'error'
      : allChecks.some((c) => c.status !== 'ok')
        ? 'degraded'
        : 'ok';

  const mem = process.memoryUsage();
  // Heap utilisation, not container utilisation. V8 grows heapTotal on demand,
  // so this sits near 90% on a healthy idle process and must not be read as
  // memory pressure — rss is the number to watch against the instance limit.
  const heapUtilization = ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1);

  cached = {
    status,
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: formatUptime(Math.floor(process.uptime())),
    environment: process.env.NODE_ENV || 'development',
    checks: { database, google, youtube, lyrics, cloudinary, asr },
    metrics: {
      memory: {
        rss: toMB(mem.rss),
        heapUsed: toMB(mem.heapUsed),
        heapTotal: toMB(mem.heapTotal),
        heapUtilization: `${heapUtilization}%`,
      },
    },
  };
  cachedAt = now;
  return cached;
}
