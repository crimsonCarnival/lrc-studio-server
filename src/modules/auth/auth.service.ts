import type { FastifyLoggerInstance } from 'fastify';
import crypto from 'crypto';
import { UAParser } from 'ua-parser-js';
import User from '../../db/user.model.js';
import Session from '../../db/session.model.js';
import { getIO } from '../../socket/socket.manager.js';
import { logUserAction } from '../user_logs/logs.service.js';
import { registerAtomically, loginAtomically } from './auth.tx.service.js';
import BannedIp from '../admin/bannedIp.model.js';
import BannedDevice from '../admin/bannedDevice.model.js';
import UserDevice from './userDevice.model.js';
import { v2 as cloudinary } from 'cloudinary';
import type { ServiceResult, AuthResponse, UserPublic } from '../../types/index.js';
import AccountNameHistory from '../../db/account-name-history.model.js';
import { sendVerification } from '../email-verification/email-verification.service.js';
import { createOnce, resolveSticky } from '../notifications/notifications.service.js';
import Passkey from '../../db/passkey.model.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { getEnv } from '../../config/env.js';
import { isValidAccountName, isReservedAccountName } from './auth.validation.js';

function getWebAuthnConfig() {
  const env = getEnv();
  const primaryOrigin = env.APP_URL;
  const origins = env.APP_URLS.length > 0 ? env.APP_URLS : [primaryOrigin];
  let rpID = 'localhost';
  try {
    rpID = new URL(primaryOrigin).hostname;
  } catch (e) {}
  return { rpID, origins, rpName: 'LRC Studio' };
}

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

interface ParsedUA {
  deviceName: string;
  browser: string;
  os: string;
  deviceType: DeviceType;
}

// Windows 11 reports "Windows NT 10.0" in the UA string — identical to Windows 10.
// The only reliable way to distinguish them is Sec-CH-UA-Platform-Version (UA Client Hints):
// Chrome/Edge on Win11 send a platform version with major >= 13 (build 22000+).
function resolveWindowsVersion(secCHUAPlatformVersion?: string): string {
  if (!secCHUAPlatformVersion) return 'Windows'; // ambiguous without the hint
  const raw = secCHUAPlatformVersion.replace(/"/g, '').trim();
  const major = parseInt(raw.split('.')[0], 10);
  if (isNaN(major)) return 'Windows';
  return major >= 13 ? 'Windows 11' : 'Windows 10';
}

function parseUA(userAgent: string, secCHUAPlatformVersion?: string): ParsedUA {
  if (!userAgent) {
    return { deviceName: 'Unknown Device', browser: 'Unknown', os: 'Unknown', deviceType: 'desktop' };
  }

  const parser = new UAParser(userAgent);
  const result = parser.getResult();

  const browserName = result.browser.name ?? 'Unknown Browser';
  const browserMajor = result.browser.major;
  const browser = browserMajor ? `${browserName} ${browserMajor}` : browserName;

  const rawOsName = result.os.name ?? 'Unknown OS';
  const osVersion = result.os.version;

  // Windows 10/11 are indistinguishable from the UA string alone — use client hint
  const osName = rawOsName === 'Windows'
    ? resolveWindowsVersion(secCHUAPlatformVersion)
    : rawOsName;

  // Shorten verbose OS version strings (e.g. "10.15.7" → "10.15"), skip for Windows
  // since we already resolved the correct label above
  const osVersionShort = (rawOsName !== 'Windows' && osVersion)
    ? osVersion.split('.').slice(0, 2).join('.')
    : undefined;
  const os = osVersionShort ? `${osName} ${osVersionShort}` : osName;

  const rawType = result.device.type;
  const deviceType: DeviceType =
    rawType === 'mobile' ? 'mobile' :
    rawType === 'tablet' ? 'tablet' :
    'desktop';

  const deviceName = `${browser} on ${os}`;

  return { deviceName, browser, os, deviceType };
}


function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type JwtTools = {
  signAccess: (p: Record<string, unknown>) => string;
  signRefresh: (p: Record<string, unknown>) => string;
  verifyToken: (t: string) => Record<string, unknown>;
};

const err = (code: string, status: number): ServiceResult => ({ error: code, code, status });

const BAN_ERRORS: Record<string, ServiceResult> = {
  IP_BANNED_LOGIN:       err('ip_banned_login', 403),
  IP_BANNED_REGISTER:    err('ip_banned_register', 403),
  IP_LINKED_BANNED_USER: err('ip_linked', 403),
  DEVICE_BANNED:         err('device_banned', 403),
  USER_BANNED:           err('account_banned', 403),
  ACCOUNT_DELETED:       err('account_deleted', 403),
};

export async function verifyRecaptcha(token: string | undefined, ip: string): Promise<boolean> {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) {
    return true;
  }
  if (!token) return false;
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secret}&response=${token}&remoteip=${ip}`
    });
    const data = await res.json() as { success: boolean; score?: number };
    return data.success && (data.score === undefined || data.score >= 0.5);
  } catch (e) {
    return false;
  }
}

function isValidDeviceIdFormat(deviceId: string): boolean {
  if (!deviceId || typeof deviceId !== 'string') return false;
  const len = deviceId.length;
  if (len < 10 || len > 256) return false;
  return deviceId.startsWith('dv_fp_') || deviceId.startsWith('dv_fallback_');
}

async function checkDevice(deviceId: string | null | undefined, user: any = null): Promise<ServiceResult> {
  if (!deviceId) return {};

  const deviceBanned = await BannedDevice.findOne({ deviceId });
  if (deviceBanned) return BAN_ERRORS.DEVICE_BANNED;

  if (user) {
    await UserDevice.findOneAndUpdate(
      { deviceId },
      { $set: { userId: user._id, lastSeen: new Date() } },
      { upsert: true }
    );
  }

  return {};
}

export async function register(
  data: { accountName?: string; displayName?: string; email?: string; password: string; recaptchaToken?: string; userAgent?: string; platformVersion?: string },
  jwt: JwtTools,
  ip: string,
  deviceId: string
): Promise<ServiceResult<AuthResponse>> {
  if (!(await verifyRecaptcha(data.recaptchaToken, ip))) {
    return err('recaptcha_failed', 403) as any;
  }

  const [ipBanned, deviceCheck] = await Promise.all([
    ip ? BannedIp.findOne({ ip }) : Promise.resolve(null),
    checkDevice(deviceId),
  ]);
  if (ipBanned) return BAN_ERRORS.IP_BANNED_REGISTER as any;
  if (deviceCheck.error) return deviceCheck as any;

  const { email, password } = data;
  const accountName = data.accountName ? data.accountName.toLowerCase().trim() : undefined;
  const displayName = data.displayName ? data.displayName.trim().slice(0, 50) : undefined;

  if (accountName) {
    if (!isValidAccountName(accountName) || isReservedAccountName(accountName)) {
      return err('accountName_taken', 409) as any;
    }
  }

  const query: Record<string, unknown>[] = [];
  if (accountName) query.push({ accountName });
  if (email) query.push({ email: email.toLowerCase() });
  const existing = await User.findOne({ $or: query });
  if (existing) {
    if (existing.ban?.active) return err('register_account_restricted', 403) as any;
    return err('accountName_taken', 409) as any;
  }

  if (ip) {
    const bannedByIp = await User.findOne({ lastIp: ip, 'ban.active': true }).lean();
    if (bannedByIp) return BAN_ERRORS.IP_LINKED_BANNED_USER as any;
  }

  const passwordHash = await User.hashPassword(password);

  const { user, accessToken, refreshToken } = await registerAtomically(
    {
      accountName,
      displayName,
      email: email ? email.toLowerCase() : undefined,
      passwordHash,
      ip,
      deviceId,
      userAgent: data.userAgent,
      platformVersion: data.platformVersion,
    },
    jwt
  );

  // Fire-and-forget: check registration badges (og, pioneer, etc.)
  import('../../modules/badges/badge.service.js')
    .then(({ triggerBadgeCheck, seedBuiltinBadges }) =>
      seedBuiltinBadges().then(() => triggerBadgeCheck(user._id.toString(), 'registration'))
    ).catch(() => {});

  logUserAction({
    userId: user._id.toString(),
    action: 'REGISTER',
    ip,
    deviceId,
    metadata: { accountName: user.accountName, email: user.email },
  });

  if (user.email) {
    sendVerification(user._id.toString(), user.email, 'initial').catch((e) => console.error('[register] sendVerification failed:', e));
    createOnce({ userId: user._id.toString(), type: 'verify_email', sticky: true }).catch(() => {});
  }

  return {
    user: user.toPublic() as any,
    accessToken,
    refreshToken,
  } as any;
}

export async function login(
  data: { identifier: string; password: string; recaptchaToken?: string; userAgent?: string; platformVersion?: string },
  jwt: JwtTools,
  ip: string,
  deviceId: string
): Promise<ServiceResult<AuthResponse>> {
  if (!(await verifyRecaptcha(data.recaptchaToken, ip))) {
    return err('recaptcha_failed', 403) as any;
  }

  const [ipBanned, deviceCheck] = await Promise.all([
    ip ? BannedIp.findOne({ ip }) : Promise.resolve(null),
    checkDevice(deviceId),
  ]);
  if (ipBanned) return BAN_ERRORS.IP_BANNED_LOGIN as any;
  if (deviceCheck.error) return deviceCheck as any;

  const { identifier, password } = data;
  const normalised = identifier.toLowerCase().trim();

  const user = await User.findOne({
    $or: [{ accountName: normalised }, { email: normalised }],
  });

  const passwordValid = user ? await user.verifyPassword(password) : false;
  if (!user || !passwordValid) {
    logUserAction({
      userId: user ? user._id.toString() : null,
      action: 'FAILED_LOGIN',
      ip,
      deviceId,
      metadata: { identifier },
    });
    return err('invalid_credentials', 401) as any;
  }

  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;

  await user.checkBanStatus();
  if (user.ban?.active) return BAN_ERRORS.USER_BANNED as any;

  const ipChanged = ip && user.lastIp !== ip;
  if (ipChanged) user.lastIp = ip;
  await checkDevice(deviceId, user);
  if (ipChanged) await User.updateOne({ _id: user._id }, { $set: { lastIp: ip } });

  const { accessToken, refreshToken } = await loginAtomically(
    user,
    jwt,
    ip,
    deviceId,
    data.userAgent,
    data.platformVersion
  );

  logUserAction({
    userId: user._id.toString(),
    action: 'LOGIN',
    ip,
    deviceId,
  });

  return {
    user: user.toPublic() as any,
    accessToken,
    refreshToken,
  } as any;
}

export async function loginByUserId(
  userId: string,
  jwt: JwtTools,
  ip: string,
  deviceId: string,
  userAgent?: string,
  platformVersion?: string
): Promise<ServiceResult<AuthResponse>> {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) return err('user_not_found', 404) as any;

  await user.checkBanStatus();
  if (user.ban?.active) return BAN_ERRORS.USER_BANNED as any;

  const { accessToken, refreshToken } = await loginAtomically(
    user,
    jwt,
    ip,
    deviceId,
    userAgent,
    platformVersion
  );

  return {
    user: user.toPublic() as any,
    accessToken,
    refreshToken,
  } as any;
}

export async function checkIdentifier(
  identifier: string,
  ip: string,
  deviceId: string
): Promise<ServiceResult<{ exists: boolean; accountName: string | null; avatarUrl: string | null }>> {
  const [ipBanned, deviceCheck] = await Promise.all([
    ip ? BannedIp.findOne({ ip }) : Promise.resolve(null),
    checkDevice(deviceId),
  ]);
  if (ipBanned) return BAN_ERRORS.IP_BANNED_LOGIN as any;
  if (deviceCheck.error) return deviceCheck as any;

  const normalised = identifier.toLowerCase().trim();
  const user = await User.findOne({
    $or: [{ accountName: normalised }, { email: normalised }],
  });

  if (!user) return err('identifier_not_found', 404) as any;
  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;

  await user.checkBanStatus();
  if (user.ban?.active) return BAN_ERRORS.USER_BANNED as any;

  const passkeyCount = await Passkey.countDocuments({ userId: user._id });

  return {
    exists: true,
    accountName: user.accountName || null,
    avatarUrl: user.avatarUrl || null,
    hasPassword: user.passwordHash !== 'OAUTH_NO_PASSWORD',
    hasGoogle: !!user.google?.googleId,
    hasPasskey: passkeyCount > 0,
  } as any;
}

export async function refresh(
  refreshToken: string,
  jwt: JwtTools,
  ip: string,
  deviceId: string
): Promise<ServiceResult<{ accessToken: string; refreshToken: string }>> {
  let decoded: Record<string, unknown>;
  try {
    decoded = jwt.verifyToken(refreshToken);
  } catch {
    return err('token_expired', 401) as any;
  }

  const user = await User.findById(decoded.sub);
  if (!user || user.isDeleted) return err('user_not_found', 401) as any;

  await user.checkBanStatus();
  if (user.ban?.active) return BAN_ERRORS.USER_BANNED as any;

  const deviceCheck = await checkDevice(deviceId, user);
  if (deviceCheck.error) return deviceCheck as any;

  if (ip && user.lastIp !== ip) {
    await User.updateOne({ _id: user._id }, { $set: { lastIp: ip } });
    user.lastIp = ip;
  }

  const familyId = decoded.familyId as string | undefined;
  if (!familyId) return err('token_expired', 401) as any;

  // Find the session for this token family
  const session = await Session.findOne({ familyId, userId: user._id });
  if (!session) return err('token_expired', 401) as any;

  // Breach Detection: if the session is already invalidated, someone is trying to reuse an old token
  if (!session.isValid) {
    // Revoke all sessions for this user!
    await Session.updateMany({ userId: user._id }, { $set: { isValid: false } });
    return err('token_reused', 401) as any;
  }

  // Verify the hash of the provided refresh token matches the one in DB
  const providedHash = hashToken(refreshToken);
  if (session.refreshTokenHash !== providedHash) {
    const isGracePeriodValid =
      session.previousRefreshTokenHash === providedHash &&
      session.previousRefreshTokenExpiry &&
      session.previousRefreshTokenExpiry > new Date();

    if (!isGracePeriodValid) {
      // Token mismatch within a valid family implies reuse
      await Session.updateMany({ userId: user._id }, { $set: { isValid: false } });
      return err('token_reused', 401) as any;
    }
    // If it is within the grace period, we allow it to proceed and generate a new token
  }

  // Issue new tokens
  const tokenPayload = { sub: user._id.toString(), accountName: user.accountName, role: user.role, familyId };
  const newAccessToken = jwt.signAccess(tokenPayload);
  const newRefreshToken = jwt.signRefresh(tokenPayload);

  // Update session with new token hash and extended expiry
  session.previousRefreshTokenHash = session.refreshTokenHash;
  session.previousRefreshTokenExpiry = new Date(Date.now() + 60 * 1000); // 60 seconds grace period
  session.refreshTokenHash = hashToken(newRefreshToken);
  session.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  session.ip = ip || session.ip;
  session.deviceId = deviceId || session.deviceId;
  session.lastUsedAt = new Date();
  await session.save();

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  } as any;
}

export async function logout(userId: string, familyId?: string): Promise<ServiceResult<{ success: boolean }>> {
  if (familyId) {
    // Invalidate specific session
    await Session.updateOne({ userId, familyId }, { $set: { isValid: false } });
  } else {
    // Fallback: invalidate all sessions (if familyId wasn't known)
    await Session.updateMany({ userId }, { $set: { isValid: false } });
  }

  logUserAction({
    userId,
    action: 'LOGOUT',
    metadata: { familyId },
  });

  return { success: true } as any;
}

export async function getProfile(
  userId: string,
  ip: string,
  deviceId?: string | null
): Promise<ServiceResult<{ user: UserPublic }>> {
  const user = await User.findById(userId);
  if (!user || user.isDeleted) return err('user_not_found', 404) as any;

  await user.checkBanStatus();

  const deviceCheck = await checkDevice(deviceId, user);
  if (deviceCheck.error) return deviceCheck as any;

  if (ip && user.lastIp !== ip) {
    await User.updateOne({ _id: user._id }, { $set: { lastIp: ip } });
    user.lastIp = ip;
  }

  return { user: user.toPublic() as any } as any;
}

export async function updateProfile(
  userId: string,
  data: any,
  logger: FastifyLoggerInstance
): Promise<ServiceResult<{ user: UserPublic }>> {
  const { avatarUrl, avatarPublicId, accountName, displayName, email, bio } = data;
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 } as any;
  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;

  if (accountName && accountName.toLowerCase().trim() !== user.accountName) {
    const ACCOUNT_NAME_COOLDOWN_DAYS = 7;
    if (user.lastAccountNameChangedAt) {
      const daysSince = (Date.now() - user.lastAccountNameChangedAt.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < ACCOUNT_NAME_COOLDOWN_DAYS) {
        const daysLeft = Math.ceil(ACCOUNT_NAME_COOLDOWN_DAYS - daysSince);
        return { error: 'accountName_change_cooldown', code: 'accountName_change_cooldown', status: 429, daysLeft } as any;
      }
    }
    const normalised = accountName.toLowerCase().trim();
    if (!isValidAccountName(normalised)) {
      return { error: 'accountName_invalid', code: 'accountName_invalid', status: 400 } as any;
    }
    if (isReservedAccountName(normalised)) {
      return { error: 'accountName_taken', code: 'accountName_taken', status: 409 } as any;
    }
    const existing = await User.findOne({ accountName: normalised });
    if (existing) return { error: 'accountName_taken', code: 'accountName_taken', status: 409 } as any;
    const previousAccountName = user.accountName;
    user.accountName = normalised;
    user.lastAccountNameChangedAt = new Date();
    AccountNameHistory.create({ userId: user._id, from: previousAccountName, to: normalised }).catch(() => {});
  }

  if (displayName !== undefined) {
    user.displayName = displayName ? displayName.trim().slice(0, 50) : null;
  }

  if (email && email.toLowerCase().trim() !== user.email && email.toLowerCase().trim() !== user.pendingEmail) {
    const normalised = email.toLowerCase().trim();
    const existing = await User.findOne({ $or: [{ email: normalised }, { pendingEmail: normalised }] });
    if (existing) return { error: 'Email already in use', status: 409 } as any;
    user.pendingEmail = normalised;
    // Fire-and-forget — don't fail the profile save if email sending fails
    sendVerification(user._id.toString(), normalised, 'email_change').catch((e) => console.error('[email_change] sendVerification failed:', e));
  }

  if (bio !== undefined) {
    user.bio = bio.trim().slice(0, 160);
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (avatarUrl !== undefined && avatarUrl !== null) {
    const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const urlLower = avatarUrl.toLowerCase();
    const isImage = ALLOWED_IMAGE_EXTENSIONS.some((ext: string) => urlLower.endsWith(`.${ext}`) || urlLower.includes(`.${ext}?`)) ||
      (avatarUrl.includes('cloudinary.com') && avatarUrl.includes('/image/upload/')) ||
      urlLower.includes('googleusercontent.com');
    if (!isImage) {
      return { error: 'Invalid image URL format. Only JPG, PNG, GIF, and WEBP are allowed.', status: 400 } as any;
    }
  }

  if (avatarUrl !== undefined && user.avatarPublicId && cloudName && apiKey && apiSecret) {
    try {
      cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
      await cloudinary.uploader.destroy(user.avatarPublicId, { resource_type: 'image' });
      logger.info({ publicId: user.avatarPublicId }, 'Old avatar deleted from Cloudinary');
    } catch (err) {
      logger.warn({ err, publicId: user.avatarPublicId }, 'Failed to delete old avatar');
    }
  }

  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (avatarPublicId !== undefined) {
    if (avatarPublicId && !avatarPublicId.startsWith('lyrics-syncer/avatars/')) {
      return { error: 'Invalid Cloudinary public ID for avatar', status: 400 } as any;
    }
    user.avatarPublicId = avatarPublicId;
  }

  await user.save();
  return { user: user.toPublic() as any } as any;
}

export async function submitAppeal(
  userId: string,
  appealText: string
): Promise<ServiceResult<{ user: UserPublic }>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 } as any;
  if (!user.ban?.active) return { error: 'User is not banned', status: 400 } as any;
  if (user.appeal.status === 'pending') {
    return err('appeal_already_pending', 409) as any;
  }

  user.appeal.text = appealText.slice(0, 1000);
  user.appeal.status = 'pending';
  user.appeal.submittedAt = new Date();
  await user.save();

  return { user: user.toPublic() as any } as any;
}

export async function clearUnbanMessage(
  userId: string
): Promise<ServiceResult<{ success: boolean }>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 } as any;
  user.showUnbanMessage = false;
  await user.save();
  return { success: true } as any;
}

// ─── Session Management ──────────────────────────────────────────────────────

export interface SessionPublic {
  id: string;
  deviceName: string;
  browser: string;
  os: string;
  deviceType: DeviceType;
  userAgent: string;
  ip: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

export async function getSessions(
  userId: string,
  currentFamilyId?: string,
  currentUA?: string,
  currentPlatformVersion?: string
): Promise<ServiceResult<{ sessions: SessionPublic[] }>> {
  const raw = await Session.find({
    userId,
    isValid: true,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastUsedAt: -1 })
    .lean();

  const healPromises: Promise<void>[] = [];

  const sessions: SessionPublic[] = raw.map((s) => {
    const isCurrent = currentFamilyId ? s.familyId === currentFamilyId : false;
    let ua = (s as any).userAgent || '';

    if (!ua && isCurrent && currentUA) {
      ua = currentUA;
      healPromises.push(
        Session.updateOne(
          { _id: (s as any)._id },
          { $set: { userAgent: currentUA, deviceName: parseUA(currentUA, currentPlatformVersion).deviceName } }
        ).exec().then(() => {})
      );
    }

    const parsed = isCurrent
      ? parseUA(ua, currentPlatformVersion)
      : parseUA(ua);

    // Prefer live-parsed values; fall back to stored deviceName for sessions missing a UA
    const storedDeviceName = (s as any).deviceName || '';
    const deviceName = ua ? parsed.deviceName : (storedDeviceName || parsed.deviceName);
    const browser = ua ? parsed.browser : (storedDeviceName ? storedDeviceName.split(' on ')[0] ?? parsed.browser : parsed.browser);
    const os      = ua ? parsed.os      : (storedDeviceName ? storedDeviceName.split(' on ')[1] ?? parsed.os      : parsed.os);

    return {
      id: (s._id as any).toString(),
      deviceName,
      browser,
      os,
      deviceType: parsed.deviceType,
      userAgent: ua,
      ip: s.ip || '',
      createdAt: (s as any).createdAt,
      lastUsedAt: (s as any).lastUsedAt || (s as any).createdAt,
      expiresAt: s.expiresAt,
      isCurrent,
    };
  });

  // Fire-and-forget heal writes — don't block the response
  if (healPromises.length) Promise.allSettled(healPromises);

  return { sessions } as any;
}

export async function revokeSession(
  userId: string,
  sessionId: string
): Promise<ServiceResult<{ success: boolean }>> {
  const session = await Session.findOne({ _id: sessionId, userId });
  if (!session) return err('session_not_found', 404) as any;
  session.isValid = false;
  await session.save();
  try { getIO().to(`user:${userId}`).emit('session:revoked', { sessionId }); } catch { /* socket not ready */ }
  return { success: true } as any;
}

export async function revokeAllSessions(
  userId: string,
  exceptFamilyId?: string
): Promise<ServiceResult<{ revokedCount: number }>> {
  const query: Record<string, unknown> = { userId };
  if (exceptFamilyId) {
    query.familyId = { $ne: exceptFamilyId };
  }
  const result = await Session.updateMany(query, { $set: { isValid: false } });
  if (result.modifiedCount > 0) {
    try { getIO().to(`user:${userId}`).emit('session:revoked', {}); } catch { /* socket not ready */ }
  }
  return { revokedCount: result.modifiedCount } as any;
}

// ─── WebAuthn (Passkeys) ─────────────────────────────────────────────────────

export async function getPasskeyRegistrationOptions(userId: string): Promise<ServiceResult<any>> {
  const user = await User.findById(userId);
  if (!user) return err('user_not_found', 404) as any;
  if (!user.isVerified) return err('email_not_verified', 403) as any;

  const userPasskeys = await Passkey.find({ userId: user._id });
  const { rpID, rpName } = getWebAuthnConfig();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new Uint8Array(Buffer.from(user._id.toString())),
    userName: user.accountName || user.email || 'user',
    attestationType: 'none',
    excludeCredentials: userPasskeys.map(passkey => ({
      id: passkey.credentialID,
      transports: passkey.transports as any,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  user.currentChallenge = options.challenge;
  await user.save();

  return { options } as any;
}

export async function verifyPasskeyRegistration(
  userId: string,
  response: RegistrationResponseJSON
): Promise<ServiceResult<{ success: boolean }>> {
  const user = await User.findById(userId);
  if (!user || !user.currentChallenge) return err('invalid_state', 400) as any;

  const expectedChallenge = user.currentChallenge;
  user.currentChallenge = null;
  await user.save();

  const { rpID, origins } = getWebAuthnConfig();

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (error: any) {
    console.error('[WebAuthn] verifyRegistrationResponse threw:', error.message, { rpID, origins });
    return err(error.message || 'verification_failed', 400) as any;
  }

  const { verified, registrationInfo } = verification;
  if (!verified || !registrationInfo) {
    console.error('[WebAuthn] verification returned unverified', { rpID, origins });
    return err('verification_failed', 400) as any;
  }

  const existingPasskey = await Passkey.findOne({ credentialID: registrationInfo.credential.id });
  if (existingPasskey) {
    return err('credential_already_in_use', 400) as any;
  }

  await Passkey.create({
    credentialID: registrationInfo.credential.id,
    credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
    counter: registrationInfo.credential.counter,
    transports: registrationInfo.credential.transports,
    userId: user._id,
  });

  resolveSticky(user._id.toString(), 'set_password').catch(() => {});

  return { success: true } as any;
}

export async function getPasskeyLoginOptions(identifier: string): Promise<ServiceResult<any>> {
  const normalised = identifier.toLowerCase().trim();
  const user = await User.findOne({
    $or: [{ accountName: normalised }, { email: normalised }],
  });
  if (!user) return err('invalid_credentials', 401) as any;

  const userPasskeys = await Passkey.find({ userId: user._id });
  if (!userPasskeys.length) return err('no_passkeys_registered', 400) as any;

  const { rpID } = getWebAuthnConfig();

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: userPasskeys.map(passkey => ({
      id: passkey.credentialID,
      transports: passkey.transports as any,
    })),
    userVerification: 'preferred',
  });

  user.currentChallenge = options.challenge;
  await user.save();

  return { options } as any;
}

export async function verifyPasskeyLogin(
  identifier: string,
  response: AuthenticationResponseJSON,
  jwt: JwtTools,
  ip: string,
  deviceId: string,
  userAgent?: string
): Promise<ServiceResult<AuthResponse>> {
  const normalised = identifier.toLowerCase().trim();
  const user = await User.findOne({
    $or: [{ accountName: normalised }, { email: normalised }],
  });
  if (!user || !user.currentChallenge) return err('invalid_credentials', 401) as any;

  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;
  await user.checkBanStatus();
  if (user.ban?.active) return BAN_ERRORS.USER_BANNED as any;

  const passkey = await Passkey.findOne({ credentialID: response.id, userId: user._id });
  if (!passkey) return err('credential_not_found', 401) as any;

  const expectedChallenge = user.currentChallenge;
  user.currentChallenge = null;
  await user.save();

  const { rpID, origins } = getWebAuthnConfig();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: passkey.credentialID,
        publicKey: new Uint8Array(passkey.credentialPublicKey),
        counter: passkey.counter,
        transports: passkey.transports as any,
      },
    });
  } catch (error: any) {
    return err(error.message || 'verification_failed', 401) as any;
  }

  if (!verification.verified) {
    return err('verification_failed', 401) as any;
  }

  passkey.counter = verification.authenticationInfo.newCounter;
  await passkey.save();

  // Issue tokens
  const { accessToken, refreshToken } = await loginAtomically(
    user,
    jwt,
    ip,
    deviceId,
    userAgent
  );

  logUserAction({
    userId: user._id.toString(),
    action: 'PASSKEY_LOGIN',
    ip,
    deviceId,
  });

  return {
    user: user.toPublic() as any,
    accessToken,
    refreshToken,
  } as any;
}

export async function getPasskeysForUser(userId: string): Promise<ServiceResult<{ passkeys: any[] }>> {
  const passkeys = await Passkey.find({ userId }).sort({ createdAt: -1 });
  const sanitized = passkeys.map(p => ({
    id: p._id.toString(),
    credentialID: p.credentialID,
    createdAt: p.createdAt,
    lastUsedAt: p.updatedAt, // Passkey models don't have lastUsedAt specifically yet, updatedAt works
    transports: p.transports || []
  }));
  return { passkeys: sanitized } as any;
}

export async function deletePasskeyForUser(userId: string, passkeyId: string): Promise<ServiceResult<{ success: boolean }>> {
  const result = await Passkey.deleteOne({ _id: passkeyId, userId });
  if (result.deletedCount === 0) {
    return err('passkey_not_found', 404) as any;
  }
  return { success: true } as any;
}

export async function deactivateUser(userId: string): Promise<ServiceResult<{ success: boolean }>> {
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 } as any;
  if (user.role === 'admin') return { error: 'Cannot deactivate an admin', status: 403 } as any;

  user.deletedAt = new Date();
  user.isDeleted = true;
  user.ban.active = false;
  user.ban.reason = null;
  user.ban.until = null;
  user.appeal.text = null;
  user.appeal.status = 'none';

  await user.save();
  return { success: true } as any;
}