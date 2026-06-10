import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import User from '../../db/user.model.js';
import { sendVerification } from '../email-verification/email-verification.service.js';
import { createOnce } from '../notifications/notifications.service.js';
import { triggerBadgeCheck, seedBuiltinBadges } from '../badges/badge.service.js';
import type { JwtPayload } from '../../types/index.js';

/**
 * Signing key for the OAuth `state` JWT. Kept SEPARATE from the session JWT
 * secret so a `state` token and an access token can never be confused for each
 * other (they're verified with different keys). Uses OAUTH_STATE_SECRET if set;
 * otherwise derives a distinct key from JWT_SECRET via domain separation, so no
 * new required env var is introduced. (F4)
 */
function getStateSecret(): string {
  if (process.env.OAUTH_STATE_SECRET) return process.env.OAUTH_STATE_SECRET;
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'change-me')
    .update('oauth-state-v1')
    .digest('hex');
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

function getClientId(): string { return process.env.GOOGLE_CLIENT_ID || ''; }
function getClientSecret(): string { return process.env.GOOGLE_CLIENT_SECRET || ''; }
function getRedirectUri(): string { return process.env.GOOGLE_REDIRECT_URI || ''; }

export function isGoogleConfigured(): boolean {
  return !!(getClientId() && getClientSecret());
}

export function generateSignedState(payload: { sub?: string; nonce?: string; action?: string; appOrigin?: string; deviceId?: string; loginHint?: string }): string {
  return jwt.sign(
    { ...payload, nonce: payload.nonce || crypto.randomBytes(8).toString('hex') },
    getStateSecret(),
    { expiresIn: '10m' },
  );
}

export function verifySignedState(state: string): Record<string, string | undefined> | null {
  try {
    const decoded = jwt.verify(state, getStateSecret()) as Record<string, string | undefined>;
    return decoded;
  } catch {
    return null;
  }
}

export function getAuthUrl(state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: getClientId() || '',
    redirect_uri: getRedirectUri(),
    scope: 'openid email profile',
    access_type: 'online',
    state,
  });
  // When we already know which account the user picked (saved-account login),
  // hint it to Google and skip the chooser so the flow continues directly.
  // Otherwise force the account chooser for a fresh sign-in.
  if (loginHint) {
    params.set('login_hint', loginHint);
  } else {
    params.set('prompt', 'select_account');
  }
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

function decodeGoogleIdToken(idToken: string): Record<string, unknown> | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return decoded;
  } catch {
    return null;
  }
}

export async function handleCallback(code: string, userId: string): Promise<Record<string, unknown>> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: getClientId() || '',
      client_secret: getClientSecret() || '',
      redirect_uri: getRedirectUri(),
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({})) as Record<string, string>;
    return { error: body.error_description || 'Token exchange failed', status: 400 };
  }

  const tokens = await tokenRes.json() as { id_token: string; access_token?: string };
  const idToken = decodeGoogleIdToken(tokens.id_token);

  if (!idToken || idToken.aud !== getClientId()) {
    return { error: 'Invalid id_token', status: 400 };
  }

  const googleId = idToken.sub as string;
  const email = idToken.email as string;
  const name = idToken.name as string;
  const picture = idToken.picture as string;

  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  // Check if this Google account is already linked to another user
  const existingUser = await User.findOne({ 'google.googleId': googleId, _id: { $ne: userId } });
  if (existingUser) {
    return { error: 'google_account_in_use', status: 409 };
  }

  user.google = {
    googleId,
    email,
    name,
    pictureUrl: picture,
  };
  await user.save();

  return {
    connected: true,
    googleId,
    email,
    name,
  };
}

export async function handleLoginCallback(code: string): Promise<Record<string, unknown>> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: getClientId() || '',
      client_secret: getClientSecret() || '',
      redirect_uri: getRedirectUri(),
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({})) as Record<string, string>;
    return { error: body.error_description || 'Token exchange failed', status: 400 };
  }

  const tokens = await tokenRes.json() as { id_token: string };
  const idToken = decodeGoogleIdToken(tokens.id_token);

  if (!idToken || idToken.aud !== getClientId()) {
    return { error: 'Invalid id_token', status: 400 };
  }

  const googleId = idToken.sub as string;
  const email = idToken.email as string;
  const name = idToken.name as string;
  const picture = idToken.picture as string;

  // Try to find user by googleId first
  let user = await User.findOne({ 'google.googleId': googleId });

  if (!user) {
    const existingEmailUser = await User.findOne({ email });
    if (existingEmailUser) {
      // First-time Google link to an existing email account — copy picture if they have none
      user = existingEmailUser;
      if (!user.google) user.google = {};
      user.google.googleId = googleId;
      user.google.email = email;
      user.google.name = name;
      user.google.pictureUrl = picture;
      if (!user.avatarUrl && picture) user.avatarUrl = picture || null;
      const wasVerified = user.isVerified;
      user.isVerified = true;
      await user.save();
      if (!wasVerified) {
        // Google-verified their email — fire the verified badge check
        triggerBadgeCheck(user._id.toString(), 'email_verified').catch(() => {});
      }
    } else {
      // Auto-generate accountName from Google display name
      const nameBase = (name || 'user')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 22);
      const base = nameBase || 'user';

      let accountName = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
      let attempt = 0;
      while (await User.findOne({ accountName }) && attempt < 10) {
        accountName = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
        attempt++;
      }

      // Brand-new user — seed avatarUrl from Google picture
      user = new User({
        accountName,
        displayName: name || accountName,
        email,
        avatarUrl: picture || undefined,
        passwordHash: 'OAUTH_NO_PASSWORD',
        google: {
          googleId,
          email,
          name,
          pictureUrl: picture,
        },
      });
      await user.save();
      if (user.email) {
        sendVerification(user._id.toString(), user.email, 'initial').catch((e) => console.error('[google] sendVerification failed:', e));
        createOnce({ userId: user._id.toString(), type: 'verify_email', sticky: true }).catch(() => {});
      }
      createOnce({ userId: user._id.toString(), type: 'set_password', sticky: true }).catch(() => {});
      // New user via Google — check registration badges (og, pioneer, etc.)
      seedBuiltinBadges()
        .then(() => triggerBadgeCheck(user!._id.toString(), 'registration'))
        .catch(() => {});
    }
  } else {
    // Returning user — update Google metadata only, never touch avatarUrl
    if (!user.google) {
      user.google = {};
    }
    user.google.googleId = googleId;
    user.google.email = email;
    user.google.name = name;
    user.google.pictureUrl = picture;
    await user.save();
  }

  return {
    userId: user._id.toString(),
    googleId,
    email,
    name,
  };
}

export async function disconnectGoogle(userId: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 };

  if (!user.google?.googleId) {
    return { error: 'provider_not_connected', status: 409 };
  }

  // Safety check: prevent account lockout
  const hasPassword = user.passwordHash !== 'OAUTH_NO_PASSWORD';
  const hasSpotify = !!user.spotify?.spotifyId;

  if (!hasPassword && !hasSpotify) {
    return {
      error: 'last_auth_method',
      status: 409,
      message: 'Cannot disconnect Google — it is your only sign-in method. Set a password first.',
    };
  }

  user.google = {
    googleId: null,
    email: null,
    name: null,
    pictureUrl: null,
  };
  await user.save();

  return { disconnected: true };
}
