import crypto from 'crypto';
import type { ClientSession } from 'mongoose';
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

function parseDeviceName(ua: string): string {
  if (!ua) return 'Unknown Device';
  const u = ua.toLowerCase();
  let os = 'Unknown OS';
  if (u.includes('windows nt')) os = 'Windows';
  else if (u.includes('mac os x') || u.includes('macos')) os = 'macOS';
  else if (u.includes('android')) os = 'Android';
  else if (u.includes('iphone') || u.includes('ipad') || u.includes('ipod')) os = 'iOS';
  else if (u.includes('linux')) os = 'Linux';
  else if (u.includes('chromeos') || u.includes('cros')) os = 'Chrome OS';

  let browser = 'Unknown Browser';
  if (u.includes('edg/') || u.includes('edge/')) browser = 'Edge';
  else if (u.includes('opr/') || u.includes('opera/')) browser = 'Opera';
  else if (u.includes('chrome/') && !u.includes('chromium/')) browser = 'Chrome';
  else if (u.includes('firefox/')) browser = 'Firefox';
  else if (u.includes('safari/') && !u.includes('chrome/')) browser = 'Safari';

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
  userData: { accountName?: string; displayName?: string; email?: string; passwordHash: string; ip: string; deviceId?: string; userAgent?: string },
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
      deviceName: parseDeviceName(ua),
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
  userAgent?: string
): Promise<AuthTokenResult> {
  return withTransaction(async (session: ClientSession) => {
    const familyId = crypto.randomUUID();
    const tokenPayload = { sub: user._id.toString(), accountName: user.accountName, role: user.role, familyId };
    const accessToken = jwt.signAccess(tokenPayload);
    const refreshToken = jwt.signRefresh(tokenPayload);

    const ua = userAgent || '';
    await Session.create([{
      userId: user._id,
      refreshTokenHash: hashToken(refreshToken),
      familyId,
      isValid: true,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ip: ip || 'unknown',
      deviceId: deviceId || 'unknown',
      userAgent: ua,
      deviceName: parseDeviceName(ua),
      lastUsedAt: new Date(),
    }], { session });

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
