import crypto from 'crypto';
import OneTimeToken from './ott.model.js';

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
 *  - Single-use: consumed atomically on first call (findOneAndDelete), so two
 *    concurrent redemptions of the same id can't both succeed
 *  - 60-second TTL: a MongoDB TTL index reaps expired entries — no per-process
 *    timer, no step to keep in sync across instances
 *  - Cryptographically random ID (16 bytes / 32 hex chars)
 *  - Mongo-backed: the mint (OAuth callback) and the consume
 *    (POST /auth/exchange-ott) can land on different instances behind a load
 *    balancer; a process-local store made that fail non-deterministically.
 */

const TTL_MS = 60_000; // 60 seconds

/**
 * Mints a new OTT for the given token pair. Returns the opaque ID to embed
 * in the callback postMessage / redirect URL.
 */
export async function createOtt(tokens: { accessToken: string; refreshToken: string }): Promise<string> {
  const id = crypto.randomBytes(16).toString('hex');
  await OneTimeToken.create({
    _id: id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  return id;
}

/**
 * Consumes an OTT. Returns the token pair on success, or null if the ID is
 * unknown or expired. findOneAndDelete is the atomic single-use guarantee —
 * a second concurrent call with the same id finds nothing to delete.
 */
export async function consumeOtt(id: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  const entry = await OneTimeToken.findOneAndDelete({ _id: id, expiresAt: { $gt: new Date() } }).lean();
  if (!entry) return null;
  return { accessToken: entry.accessToken, refreshToken: entry.refreshToken };
}
