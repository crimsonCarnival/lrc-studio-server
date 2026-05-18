import crypto from 'crypto';
import type { ClientSession } from 'mongoose';
import User, { type IUser } from '../../db/user.model.js';
import Session from '../../db/session.model.js';
import PasswordReset from '../../db/passwordReset.model.js';
import { withTransaction } from '../../db/transaction.js';

type JwtTools = {
  signAccess: (p: Record<string, unknown>) => string;
  signRefresh: (p: Record<string, unknown>) => string;
};

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface AuthTokenResult {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterResult extends AuthTokenResult {
  user: IUser;
}

export async function registerAtomically(
  userData: { username?: string; email?: string; passwordHash: string; ip: string; deviceId?: string },
  jwt: JwtTools
): Promise<RegisterResult> {
  return withTransaction(async (session: ClientSession) => {
    const [user] = await User.create([{
      ...(userData.username ? { username: userData.username } : {}),
      ...(userData.email ? { email: userData.email } : {}),
      passwordHash: userData.passwordHash,
      lastIp: userData.ip,
      deviceIds: userData.deviceId ? [userData.deviceId] : [],
    }], { session });

    const familyId = crypto.randomUUID();
    const tokenPayload = { sub: user._id.toString(), username: user.username, role: user.role, familyId };
    const accessToken = jwt.signAccess(tokenPayload);
    const refreshToken = jwt.signRefresh(tokenPayload);

    await Session.create([{
      userId: user._id,
      refreshTokenHash: hashToken(refreshToken),
      familyId,
      isValid: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ip: userData.ip || 'unknown',
      deviceId: userData.deviceId || 'unknown',
    }], { session });

    return { user, accessToken, refreshToken };
  }, { operation: 'registerAtomically' });
}

export async function loginAtomically(
  user: IUser,
  jwt: JwtTools,
  ip: string,
  deviceId: string
): Promise<AuthTokenResult> {
  return withTransaction(async (session: ClientSession) => {
    const familyId = crypto.randomUUID();
    const tokenPayload = { sub: user._id.toString(), username: user.username, role: user.role, familyId };
    const accessToken = jwt.signAccess(tokenPayload);
    const refreshToken = jwt.signRefresh(tokenPayload);

    await Session.create([{
      userId: user._id,
      refreshTokenHash: hashToken(refreshToken),
      familyId,
      isValid: true,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      ip: ip || 'unknown',
      deviceId: deviceId || 'unknown',
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
