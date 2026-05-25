import crypto from 'crypto';
import User from '../../db/user.model.js';
import EmailVerification from '../../db/email-verification.model.js';
import EmailHistory from '../../db/email-history.model.js';
import { sendVerificationEmail } from '../email/email.service.js';
import { getEnv } from '../../config/env.js';
import { resolveSticky } from '../notifications/notifications.service.js';

export class VerificationError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

export async function sendVerification(userId: string, email: string, type: 'initial' | 'email_change'): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentCount = await EmailVerification.countDocuments({
    userId,
    createdAt: { $gte: oneHourAgo },
  });

  if (recentCount >= 3) {
    throw new VerificationError('rate_limited', 429, 'Too many verification requests. Please try again later.');
  }

  await EmailVerification.updateMany({ userId, type, isUsed: false }, { $set: { isUsed: true } });

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await EmailVerification.create({
    userId,
    email,
    type,
    tokenHash,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    isUsed: false,
  });

  const clientUrl = getEnv().APP_URL;
  const verifyLink = `${clientUrl}/verify-email?token=${token}`;

  const user = await User.findById(userId).select('displayName accountName');
  await sendVerificationEmail(email, verifyLink, user?.displayName || user?.accountName);
}

export async function verifyEmailToken(rawToken: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Atomically claim the token — prevents double-verification from concurrent requests
  const doc = await EmailVerification.findOneAndUpdate(
    { tokenHash, isUsed: false, expiresAt: { $gt: new Date() } },
    { $set: { isUsed: true } },
    { new: true }
  );

  if (!doc) {
    // Secondary lookup only to give a more useful error — the atomic check above is the guard
    const staleDoc = await EmailVerification.findOne({ tokenHash });
    if (staleDoc && staleDoc.expiresAt < new Date()) {
      throw new VerificationError('token_expired', 400, 'Verification link has expired.');
    }
    throw new VerificationError('invalid_token', 400, 'Invalid or already used verification link.');
  }

  const user = await User.findById(doc.userId);
  if (!user) {
    throw new VerificationError('user_not_found', 404, 'User not found.');
  }

  user.isVerified = true;

  if (doc.type === 'email_change') {
    if (!user.pendingEmail) {
      throw new VerificationError('invalid_state', 500, 'No pending email to verify.');
    }
    await EmailHistory.create({ userId: user._id, from: user.email, to: user.pendingEmail });
    user.email = user.pendingEmail;
    user.pendingEmail = null;
  }

  await user.save();
  resolveSticky(user._id.toString(), 'verify_email').catch(() => {});
}

export async function resendVerification(userId: string): Promise<void> {
  const user = await User.findById(userId).select('email pendingEmail isVerified');
  if (!user) {
    throw new VerificationError('user_not_found', 404, 'User not found.');
  }

  if (user.pendingEmail) {
    await sendVerification(userId, user.pendingEmail, 'email_change');
  } else if (user.email && !user.isVerified) {
    await sendVerification(userId, user.email, 'initial');
  } else {
    throw new VerificationError('nothing_to_verify', 400, 'No pending email verification found.');
  }
}
