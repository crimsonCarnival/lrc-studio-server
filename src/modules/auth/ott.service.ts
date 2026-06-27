import crypto from 'crypto';

/**
 * One-Time Token (OTT) store for the Google OAuth login flow.
 *
 * The OAuth callback sets auth cookies directly on the Render backend domain,
 * but the client fetches through Vercel's /api proxy. Cookies set on
 * lrc-editor-server.onrender.com are never sent to lrc-studio.vercel.app/api.
 *
 * Fix: instead of setting cookies in the callback, we mint a short-lived OTT
 * that the client exchanges via POST /auth/exchange-ott — which goes through
 * the Vercel proxy, so the server sets cookies on the proxied response and the
 * browser scopes them to lrc-studio.vercel.app. ✓
 *
 * Security properties:
 *  - Single-use: consumed on first call, removed immediately
 *  - 60-second TTL: stale tokens auto-reaped by background cleanup
 *  - Cryptographically random ID (16 bytes / 32 hex chars)
 *  - In-memory only: never written to disk or DB (safe for single instance)
 */

interface OttEntry {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Date.now() + TTL_MS
}

const TTL_MS = 60_000; // 60 seconds
const store = new Map<string, OttEntry>();

// Reap expired tokens every 2 minutes — keeps memory bounded
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}, 2 * 60_000).unref(); // .unref() so the timer doesn't keep Node alive

/**
 * Mints a new OTT for the given token pair. Returns the opaque ID to embed
 * in the callback postMessage / redirect URL.
 */
export function createOtt(tokens: { accessToken: string; refreshToken: string }): string {
  const id = crypto.randomBytes(16).toString('hex');
  store.set(id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + TTL_MS,
  });
  return id;
}

/**
 * Consumes an OTT. Returns the token pair on success, or null if the ID is
 * unknown or expired. The entry is deleted immediately — single-use.
 */
export function consumeOtt(id: string): { accessToken: string; refreshToken: string } | null {
  const entry = store.get(id);
  if (!entry) return null;
  store.delete(id); // single-use: remove before returning
  if (entry.expiresAt <= Date.now()) return null;
  return { accessToken: entry.accessToken, refreshToken: entry.refreshToken };
}
