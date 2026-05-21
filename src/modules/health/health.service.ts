import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';

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
    spotify: ServiceCheck;
    google: ServiceCheck;
    youtube: ServiceCheck;
    genius: ServiceCheck;
    cloudinary: ServiceCheck;
  };
  metrics: {
    memory: { used: string; total: string; percentUsed: string };
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

export async function getHealth(): Promise<HealthResponse> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  const database = await checkDatabase();
  const spotify = checkConfigured(['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
  const google = checkConfigured(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const youtube = checkConfigured(['YOUTUBE_API_KEY']);
  const genius = checkConfigured(['GENIUS_CLIENT_ACCESS_TOKEN']);
  const cloudinary = checkConfigured(['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);

  const allChecks = [database, spotify, google, youtube, genius, cloudinary];
  const status: CheckStatus =
    database.status === 'error'
      ? 'error'
      : allChecks.some((c) => c.status !== 'ok')
        ? 'degraded'
        : 'ok';

  const mem = process.memoryUsage();
  const percentUsed = ((mem.heapUsed / mem.heapTotal) * 100).toFixed(1);

  cached = {
    status,
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: formatUptime(Math.floor(process.uptime())),
    environment: process.env.NODE_ENV || 'development',
    checks: { database, spotify, google, youtube, genius, cloudinary },
    metrics: {
      memory: { used: toMB(mem.heapUsed), total: toMB(mem.heapTotal), percentUsed: `${percentUsed}%` },
    },
  };
  cachedAt = now;
  return cached;
}
