import type { FastifyLoggerInstance } from 'fastify';
import User from '../../db/user.model.js';
import BannedIp from '../admin/bannedIp.model.js';
import BannedDevice from '../admin/bannedDevice.model.js';
import { v2 as cloudinary } from 'cloudinary';
import type { ServiceResult, AuthResponse, UserPublic } from '../../types/index.js';

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

  if (user && !user.deviceIds.includes(deviceId)) {
    if (user.deviceIds.length >= 20) {
      user.deviceIds.shift();
    }
    user.deviceIds.push(deviceId);
    await user.save();
  }

  return {};
}

export async function register(
  data: { username?: string; email?: string; password: string; recaptchaToken?: string },
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

  const { username, email, password } = data;

  const query: Record<string, unknown>[] = [];
  if (username) query.push({ username });
  if (email) query.push({ email: email.toLowerCase() });
  const existing = await User.findOne({ $or: query });
  if (existing) {
    if (existing.isBanned) return err('register_account_restricted', 403) as any;
    return err('username_taken', 409) as any;
  }

  if (ip) {
    const bannedByIp = await User.findOne({ lastIp: ip, isBanned: true }).lean();
    if (bannedByIp) return BAN_ERRORS.IP_LINKED_BANNED_USER as any;
  }

  const passwordHash = await User.hashPassword(password);
  const user = await User.create({
    ...(username ? { username } : {}),
    ...(email ? { email: email.toLowerCase() } : {}),
    passwordHash,
    lastIp: ip,
    deviceIds: deviceId ? [deviceId] : [],
  });

  const tokenPayload = { sub: user._id.toString(), username: user.username, role: user.role };
  return {
    user: user.toPublic() as any,
    accessToken: jwt.signAccess(tokenPayload),
    refreshToken: jwt.signRefresh(tokenPayload),
  } as any;
}

export async function login(
  data: { identifier: string; password: string; recaptchaToken?: string },
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
    $or: [{ username: identifier.trim() }, { email: normalised }],
  });

  const passwordValid = user ? await user.verifyPassword(password) : false;
  if (!user || !passwordValid) {
    return err('invalid_credentials', 401) as any;
  }

  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;

  await user.checkBanStatus();
  if (user.isBanned) return BAN_ERRORS.USER_BANNED as any;

  const ipChanged = ip && user.lastIp !== ip;
  if (ipChanged) user.lastIp = ip;
  await checkDevice(deviceId, user);
  if (ipChanged && !user.isModified()) await user.save();

  const tokenPayload = { sub: user._id.toString(), username: user.username, role: user.role };
  return {
    user: user.toPublic() as any,
    accessToken: jwt.signAccess(tokenPayload),
    refreshToken: jwt.signRefresh(tokenPayload),
  } as any;
}

export async function checkIdentifier(
  identifier: string,
  ip: string,
  deviceId: string
): Promise<ServiceResult<{ exists: boolean; username: string | null; avatarUrl: string | null }>> {
  const [ipBanned, deviceCheck] = await Promise.all([
    ip ? BannedIp.findOne({ ip }) : Promise.resolve(null),
    checkDevice(deviceId),
  ]);
  if (ipBanned) return BAN_ERRORS.IP_BANNED_LOGIN as any;
  if (deviceCheck.error) return deviceCheck as any;

  const normalised = identifier.toLowerCase().trim();
  const user = await User.findOne({
    $or: [{ username: identifier.trim() }, { email: normalised }],
  });

  if (!user) return err('identifier_not_found', 404) as any;
  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;

  await user.checkBanStatus();
  if (user.isBanned) return BAN_ERRORS.USER_BANNED as any;

  return {
    exists: true,
    username: user.username || null,
    avatarUrl: user.avatarUrl || null,
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
  if (user.isBanned) return BAN_ERRORS.USER_BANNED as any;

  const deviceCheck = await checkDevice(deviceId, user);
  if (deviceCheck.error) return deviceCheck as any;

  if (ip && user.lastIp !== ip) {
    user.lastIp = ip;
    if (!user.isModified()) await user.save();
  }

  const tokenPayload = { sub: user._id.toString(), username: user.username, role: user.role };
  return {
    accessToken: jwt.signAccess(tokenPayload),
    refreshToken: jwt.signRefresh(tokenPayload),
  } as any;
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
    user.lastIp = ip;
    if (!user.isModified()) await user.save();
  }

  return { user: user.toPublic() as any } as any;
}

export async function updateProfile(
  userId: string,
  data: any,
  logger: FastifyLoggerInstance
): Promise<ServiceResult<{ user: UserPublic }>> {
  const { avatarUrl, avatarPublicId, username, email, bio } = data;
  const user = await User.findById(userId);
  if (!user) return { error: 'User not found', status: 404 } as any;
  if (user.isDeleted) return BAN_ERRORS.ACCOUNT_DELETED as any;

  if (username && username !== user.username) {
    const existing = await User.findOne({ username: username.trim() });
    if (existing) return { error: 'Username already taken', status: 409 } as any;
    user.username = username.trim();
  }

  if (email && email.toLowerCase().trim() !== user.email) {
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) return { error: 'Email already in use', status: 409 } as any;
    user.email = email.toLowerCase().trim();
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
      (avatarUrl.includes('cloudinary.com') && avatarUrl.includes('/image/upload/'));
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
  if (!user.isBanned) return { error: 'User is not banned', status: 400 } as any;
  if (user.appealStatus === 'pending') {
    return err('appeal_already_pending', 409) as any;
  }

  user.banAppeal = appealText.slice(0, 1000);
  user.appealStatus = 'pending';
  user.appealAt = new Date();
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