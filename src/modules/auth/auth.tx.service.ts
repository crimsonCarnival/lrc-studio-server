import crypto from 'crypto';
import type { ClientSession } from 'mongoose';
import { UAParser } from 'ua-parser-js';
import User, { type IUser } from '../../db/user.model.js';
import Session from '../../db/session.model.js';
import PasswordReset from '../../db/passwordReset.model.js';
import UserDevice from './userDevice.model.js';
import { withTransaction } from '../../db/transaction.js';

type JwtTools = {
  signAccess: (p: Record<string, unknown>) => string;
  signRefresh: (p: Record<string, unknown>) => string;
};

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function resolveWindowsVersion(secCHUAPlatformVersion?: string): string {
  if (!secCHUAPlatformVersion) return 'Windows';
  const raw = secCHUAPlatformVersion.replace(/"/g, '').trim();
  const major = parseInt(raw.split('.')[0], 10);
  if (isNaN(major)) return 'Windows';
  return major >= 13 ? 'Windows 11' : 'Windows 10';
}

function buildDeviceName(ua: string, platformVersion?: string): string {
  if (!ua) return 'Unknown Device';
  const r = new UAParser(ua).getResult();
  const browser = r.browser.major
    ? `${r.browser.name ?? 'Unknown'} ${r.browser.major}`
    : (r.browser.name ?? 'Unknown Browser');
  const rawOsName = r.os.name ?? 'Unknown OS';
  const os = rawOsName === 'Windows'
    ? resolveWindowsVersion(platformVersion)
    : (r.os.version?.split('.').slice(0, 2).join('.')
        ? `${rawOsName} ${r.os.version!.split('.').slice(0, 2).join('.')}`
        : rawOsName);
  return `${browser} on ${os}`;
}

export interface AuthTokenResult {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterResult extends AuthTokenResult {
  user: IUser;
}

export async function registerAtomically(
  userData: { accountName?: string; displayName?: string; email?: string; passwordHash: string; ip: string; deviceId?: string; userAgent?: string; platformVersion?: string },
  jwt: JwtTools
): Promise<RegisterResult> {
  return withTransaction(async (session: ClientSession) => {
    const [user] = await User.create([{
      ...(userData.accountName ? { accountName: userData.accountName } : {}),
      ...(userData.displayName ? { displayName: userData.displayName } : {}),
      ...(userData.email ? { email: userData.email } : {}),
      passwordHash: userData.passwordHash,
      lastIp: userData.ip,
    }], { session });

    if (userData.deviceId) {
      await UserDevice.create([{ userId: user._id, deviceId: userData.deviceId }], { session });
    }

    const familyId = crypto.randomUUID();
    const tokenPayload = { sub: user._id.toString(), accountName: user.accountName, role: user.role, familyId };
    const accessToken = jwt.signAccess(tokenPayload);
    const refreshToken = jwt.signRefresh(tokenPayload);

    const ua = userData.userAgent || '';
    await Session.create([{
      userId: user._id,
      refreshTokenHash: hashToken(refreshToken),
      familyId,
      isValid: true,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip: userData.ip || 'unknown',
      deviceId: userData.deviceId || 'unknown',
      userAgent: ua,
      deviceName: buildDeviceName(ua, userData.platformVersion),
      lastUsedAt: new Date(),
    }], { session });

    return { user, accessToken, refreshToken };
  }, { operation: 'registerAtomically' });
}

export async function loginAtomically(
  user: IUser,
  jwt: JwtTools,
  ip: string,
  deviceId: string,
  userAgent?: string,
  platformVersion?: string
): Promise<AuthTokenResult> {
  return withTransaction(async (session: ClientSession) => {
    const familyId = crypto.randomUUID();
    const tokenPayload = { sub: user._id.toString(), accountName: user.accountName, role: user.role, familyId };
    const accessToken = jwt.signAccess(tokenPayload);
    const refreshToken = jwt.signRefresh(tokenPayload);

    const ua = userAgent || '';
    const resolvedDeviceId = deviceId || 'unknown';
    const newDeviceName = buildDeviceName(ua, platformVersion);

    // Upsert: reuse existing session for this device instead of accumulating one per login
    const existing = await Session.findOne({ userId: user._id, deviceId: resolvedDeviceId, isValid: true }).session(session);
    if (existing) {
      await Session.updateOne(
        { _id: existing._id },
        {
          $set: {
            refreshTokenHash: hashToken(refreshToken),
            familyId,
            ip: ip || 'unknown',
            // Only overwrite UA/deviceName if we have new data; keep old values otherwise
            ...(ua ? { userAgent: ua, deviceName: newDeviceName } : {}),
            lastUsedAt: new Date(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        },
        { session }
      );
    } else {
      await Session.create([{
        userId: user._id,
        refreshTokenHash: hashToken(refreshToken),
        familyId,
        isValid: true,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ip: ip || 'unknown',
        deviceId: resolvedDeviceId,
        userAgent: ua,
        deviceName: newDeviceName,
        lastUsedAt: new Date(),
      }], { session });
    }

    return { accessToken, refreshToken };
  }, { operation: 'loginAtomically', userId: user._id.toString() });
}

export async function resetPasswordAtomically(
  email: string,
  passwordHash: string
): Promise<void> {
  return withTransaction(async (session: ClientSession) => {
    // Update user password
    await User.updateOne(
      { email },
      { passwordHash, passwordChangedAt: new Date() },
      { session }
    );

    // Mark reset token as used
    await PasswordReset.updateOne(
      { email },
      { isUsed: true },
      { session }
    );
  }, { operation: 'resetPasswordAtomically', email });
}

export async function changePasswordAtomically(
  userId: string,
  passwordHash: string
): Promise<void> {
  return withTransaction(async (session: ClientSession) => {
    // Update user password
    await User.updateOne(
      { _id: userId },
      { passwordHash, passwordChangedAt: new Date() },
      { session }
    );
  }, { operation: 'changePasswordAtomically', userId });
}
