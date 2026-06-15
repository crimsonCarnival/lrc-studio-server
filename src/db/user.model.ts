import mongoose, { type Document, type Model } from 'mongoose';
import argon2 from 'argon2';
import bcrypt from 'bcrypt';
import { UserPublic } from '../types/index.js';

/**
 * Argon2id parameters — OWASP recommended minimums for interactive logins.
 * Argon2id is the hybrid variant: resistant to GPU/ASIC brute-force AND
 * side-channel attacks. We keep bcrypt imported only for the transparent
 * migration path: existing hashes are verified + silently re-hashed on login.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MB — OWASP minimum; 64 MB caused OOM in constrained envs
  timeCost: 3,           // 3 iterations
  parallelism: 1,        // 1 thread — avoids CPU contention on multi-tenant servers
};

const BCRYPT_SALT_ROUNDS = 12; // kept only for migration verification

export interface IBan {
  active: boolean;
  reason?: string | null;
  until?: Date | null;
}

export interface IAppeal {
  text?: string | null;
  status: 'none' | 'pending' | 'rejected';
  submittedAt?: Date | null;
  resolvedAt?: Date | null;
}

export interface ISocial {
  followerCount: number;
  followingCount: number;
  showFollowers: boolean;
  totalStarsReceived: number;
  totalForksReceived: number;
}

export interface IUserBadge {
  id: string;
  grantedAt: Date;
  grantedBy: string;
}

export interface IUserStats {
  minutesSynced: number;
  wordsSynced: number;
  karaokeLines: number;
}

export interface IUserStreak {
  current: number;
  longest: number;
  lastActiveDate?: Date | null;
}

export interface IUserProgression {
  xp: number;
  level: number;
}

export interface IUser extends Document {
  accountName?: string;
  displayName?: string | null;
  lastAccountNameChangedAt?: Date | null;
  email?: string;
  pendingEmail?: string | null;
  passwordHash: string;
  passwordChangedAt?: Date | null;
  avatarUrl?: string | null;
  avatarPublicId?: string | null;
  isVerified: boolean;
  ban: IBan;
  appeal: IAppeal;
  deletedAt?: Date | null;
  isDeleted: boolean;
  role: 'user' | 'admin';
  google?: {
    googleId?: string | null;
    email?: string | null;
    name?: string | null;
    pictureUrl?: string | null;
  };
  social?: ISocial;
  lastIp?: string | null;
  bio: string;
  currentChallenge?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  // Stats subdoc
  stats?: IUserStats;
  // Streak subdoc
  streak?: IUserStreak;
  // Badges
  badges: IUserBadge[];
  showcasedBadges: string[];
  showcasePublic: boolean;
  // Progression subdoc
  progression?: IUserProgression;

  verifyPassword(plain: string): Promise<boolean>;
  toPublic(): Record<string, unknown>;
  checkBanStatus(): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {
  hashPassword(plain: string): Promise<string>;
}

const banSchema = new mongoose.Schema<IBan>(
  {
    active: { type: Boolean, default: false },
    reason: { type: String, default: null, maxlength: 500 },
    until: { type: Date, default: null },
  },
  { _id: false }
);

const appealSchema = new mongoose.Schema<IAppeal>(
  {
    text: { type: String, default: null, maxlength: 1000 },
    status: { type: String, enum: ['none', 'pending', 'rejected'], default: 'none' },
    submittedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false }
);

const socialSchema = new mongoose.Schema<ISocial>(
  {
    followerCount:      { type: Number, default: 0, min: 0 },
    followingCount:     { type: Number, default: 0, min: 0 },
    showFollowers:      { type: Boolean, default: true },
    totalStarsReceived: { type: Number, default: 0, min: 0 },
    totalForksReceived: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const userBadgeSchema = new mongoose.Schema<IUserBadge>(
  {
    id:        { type: String, required: true },
    grantedAt: { type: Date,   default: Date.now },
    grantedBy: { type: String, default: 'system' },
  },
  { _id: false }
);

const statsSchema = new mongoose.Schema<IUserStats>(
  {
    minutesSynced: { type: Number, default: 0, min: 0 },
    wordsSynced:   { type: Number, default: 0, min: 0 },
    karaokeLines:  { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const streakSchema = new mongoose.Schema<IUserStreak>(
  {
    current:        { type: Number, default: 0, min: 0 },
    longest:        { type: Number, default: 0, min: 0 },
    lastActiveDate: { type: Date,   default: null },
  },
  { _id: false }
);

const progressionSchema = new mongoose.Schema<IUserProgression>(
  {
    xp:    { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema<IUser>(
  {
    accountName: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: /^[a-z0-9.:_-]+$/,
    },
    displayName: {
      type: String,
      default: null,
      trim: true,
      maxlength: 50,
    },
    lastAccountNameChangedAt: {
      type: Date,
      default: null,
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    pendingEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      sparse: true,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    avatarUrl: {
      type: String,
      default: null,
    },
    avatarPublicId: {
      type: String,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    ban: { type: banSchema, default: () => ({}) },
    appeal: { type: appealSchema, default: () => ({}) },
    deletedAt: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    google: {
      googleId: { type: String, default: null },
      email: { type: String, default: null },
      name: { type: String, default: null },
      pictureUrl: { type: String, default: null },
    },
    lastIp: {
      type: String,
      default: null,
    },
    bio: {
      type: String,
      default: '',
      maxlength: 160,
    },
    social: { type: socialSchema, default: () => ({}) },
    currentChallenge: {
      type: String,
      default: null,
    },
    stats:       { type: statsSchema,       default: () => ({}) },
    streak:      { type: streakSchema,      default: () => ({}) },
    badges:          { type: [userBadgeSchema], default: [] },
    showcasedBadges: { type: [String], default: [] },
    showcasePublic:  { type: Boolean, default: true },
    progression: { type: progressionSchema, default: () => ({}) },
  },
  { timestamps: true, collection: 'users' }
);

// At least one identifier required
userSchema.pre('validate', function (this: IUser, next: mongoose.CallbackWithoutResultAndOptionalError) {
  if (!this.accountName && !this.email) {
    return next(new Error('Either accountName or email is required'));
  }
  next();
});

// Prevent duplicate Google account links
userSchema.index({ 'google.googleId': 1 }, { unique: true, sparse: true });

// Enables $text search in admin user listing
userSchema.index({ accountName: 'text', email: 'text' });

// Soft-delete filter support
userSchema.index({ isDeleted: 1 });

/**
 * Verifies the provided plaintext password against the stored hash.
 * Handles transparent migration from legacy bcrypt hashes:
 * if a bcrypt hash is detected ($2b$ / $2a$), it verifies with bcrypt
 * and rehashes to Argon2id in the background to migrate on next login.
 */
userSchema.methods.verifyPassword = async function (this: IUser, plain: string): Promise<boolean> {
  // Sentinel value for OAuth-only users (no password set)
  if (this.passwordHash === 'OAUTH_NO_PASSWORD') return false;

  // Detect legacy bcrypt hash
  if (this.passwordHash.startsWith('$2b$') || this.passwordHash.startsWith('$2a$')) {
    const match = await bcrypt.compare(plain, this.passwordHash);
    if (match) {
      // Silently migrate to Argon2id
      this.passwordHash = await argon2.hash(plain, ARGON2_OPTIONS);
      await this.save();
    }
    return match;
  }
  return argon2.verify(this.passwordHash, plain);
};

userSchema.statics.hashPassword = function (plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
};

// Never leak sensitive fields
userSchema.methods.toPublic = function (this: IUser): Record<string, unknown> {
  return {
    id: this._id.toString(),
    accountName: this.accountName,
    displayName: this.displayName ?? null,
    email: this.email,
    pendingEmail: this.pendingEmail ?? null,
    avatarUrl: this.avatarUrl,
    bio: this.bio || '',
    isVerified: this.isVerified,
    ban: {
      active: this.ban?.active ?? false,
      ...(this.ban?.active ? { reason: this.ban.reason, until: this.ban.until } : {}),
    },
    appeal: this.ban?.active ? {
      text: this.appeal?.text ?? null,
      status: this.appeal?.status ?? 'none',
      submittedAt: this.appeal?.submittedAt ?? null,
      resolvedAt: this.appeal?.resolvedAt ?? null,
    } : null,
    role: this.role,
    createdAt: this.createdAt,
    passwordChangedAt: this.passwordChangedAt,
    lastAccountNameChangedAt: this.lastAccountNameChangedAt ?? null,
    hasPassword: this.passwordHash !== 'OAUTH_NO_PASSWORD',
    google: this.google?.googleId ? {
      connected: true,
      googleId: this.google.googleId,
      email: this.google.email,
      name: this.google.name,
      pictureUrl: this.google.pictureUrl,
    } : { connected: false },
    showFollowers: this.social?.showFollowers ?? true,
    badges:         this.badges ?? [],
    showcasedBadges: this.showcasedBadges ?? [],
    showcasePublic:  this.showcasePublic ?? true,
    stats: {
      minutesSynced: this.stats?.minutesSynced ?? 0,
      wordsSynced:   this.stats?.wordsSynced ?? 0,
      karaokeLines:  this.stats?.karaokeLines ?? 0,
    },
    streak: {
      current:        this.streak?.current ?? 0,
      longest:        this.streak?.longest ?? 0,
      lastActiveDate: this.streak?.lastActiveDate ?? null,
    },
    progression: {
      xp:    this.progression?.xp ?? 0,
      level: this.progression?.level ?? 0,
    },
  };
};

/**
 * Checks if the user's ban has expired.
 * If expired, clears the ban and appeal state.
 * Returns true so the caller knows to surface a wasJustUnbanned signal.
 */
userSchema.methods.checkBanStatus = async function (this: IUser): Promise<boolean> {
  if (!this.ban?.active) return false;

  if (this.ban.until && this.ban.until <= new Date()) {
    this.ban.active = false;
    this.ban.reason = null;
    this.ban.until = null;
    this.appeal.text = null;
    this.appeal.status = 'none';
    this.appeal.submittedAt = null;
    await this.save();
    return true;
  }

  return false;
};

export default mongoose.model<IUser, IUserModel>('User', userSchema);
