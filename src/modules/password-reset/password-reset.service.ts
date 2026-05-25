import crypto from 'crypto';
import User from '../../db/user.model.js';
import PasswordReset from '../../db/passwordReset.model.js';
import { sendPasswordResetEmail, sendPasswordChangedEmail } from '../email/email.service.js';
import { resolveSticky, createOnce } from '../notifications/notifications.service.js';
import { resetPasswordAtomically, changePasswordAtomically } from '../auth/auth.tx.service.js';
import { getEnv } from '../../config/env.js';

export class PasswordResetError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'PasswordResetError';
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  // Check rate limit: max 2 per hour
  const recentAttempts = await PasswordReset.find({
    email: normalizedEmail,
    createdAt: { $gte: new Date(Date.now() - 3600000) },
  });

  if (recentAttempts.length >= 2) {
    throw new PasswordResetError('rate_limited', 429, 'Too many password reset requests');
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Create reset token document
  await PasswordReset.create({
    email: normalizedEmail,
    tokenHash,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    isUsed: false,
  });

  // Send email (don't fail if email sending fails - user can retry)
  const resetUrl = getEnv().PASSWORD_RESET_URL;
  const resetLink = `${resetUrl}/reset-password?token=${token}`;
  try {
    await sendPasswordResetEmail(normalizedEmail, resetLink);
  } catch (err) {
    console.error('Failed to send password reset email:', err);
  }
}

export async function validateResetToken(token: string): Promise<{ email: string }> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const doc = await PasswordReset.findOne({ tokenHash });

  if (!doc || doc.expiresAt < new Date() || doc.isUsed) {
    throw new PasswordResetError('invalid_token', 404, 'Invalid or expired reset link');
  }

  return { email: doc.email };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const { email } = await validateResetToken(token);

  // Validate new password
  if (!newPassword || newPassword.length < 8) {
    throw new PasswordResetError('invalid_password', 400, 'Password must be at least 8 characters');
  }

  // Fetch user to check old password
  const user = await User.findOne({ email });
  if (!user) {
    throw new PasswordResetError('user_not_found', 404, 'User not found');
  }

  // Ensure new password differs from old
  const isSame = await user.verifyPassword(newPassword);
  if (isSame) {
    throw new PasswordResetError('same_password', 400, 'New password must be different from current password');
  }

  // Hash new password
  const passwordHash = await User.hashPassword(newPassword);

  // Update atomically
  await resetPasswordAtomically(email, passwordHash);
}

export async function changePassword(userId: string, currentPassword: string | null, newPassword: string, isSetPassword = false): Promise<void> {
  // Fetch user
  const user = await User.findById(userId);
  if (!user) {
    throw new PasswordResetError('user_not_found', 404, 'User not found');
  }

  // If not setting password (changing existing), verify current password
  if (!isSetPassword) {
    const isCorrect = await user.verifyPassword(currentPassword!);
    if (!isCorrect) {
      throw new PasswordResetError('incorrect_password', 401, 'Current password is incorrect');
    }
  } else {
    // Setting password: only allowed for OAuth-only users
    if (user.passwordHash !== 'OAUTH_NO_PASSWORD') {
      throw new PasswordResetError('use_change_password', 400, 'Use the change password endpoint instead');
    }
  }

  // Validate new password
  if (!newPassword || newPassword.length < 8) {
    throw new PasswordResetError('invalid_password', 400, 'Password must be at least 8 characters');
  }

  // Ensure new password differs from old (skip for setPassword since old is sentinel)
  if (!isSetPassword) {
    const isSame = await user.verifyPassword(newPassword);
    if (isSame) {
      throw new PasswordResetError('same_password', 400, 'New password must be different from current password');
    }
  }

  // Hash new password
  const passwordHash = await User.hashPassword(newPassword);

  // Update atomically
  await changePasswordAtomically(userId, passwordHash);
  resolveSticky(userId, 'set_password').catch(() => {});
  createOnce({ userId, type: 'password_changed', sticky: false }).catch(() => {});
  if (user.email) {
    sendPasswordChangedEmail(user.email, (user as any).displayName || user.accountName).catch(() => {});
  }
}
