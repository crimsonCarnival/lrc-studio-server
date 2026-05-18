import mongoose, { type Document, type Model, type HydratedDocument } from 'mongoose';
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
  memoryCost: 64 * 1024, // 64 MB
  timeCost: 3,           // 3 iterations
  parallelism: 4,        // 4 threads
};

const BCRYPT_SALT_ROUNDS = 12; // kept only for migration verification

export interface IUser extends Document {
  username?: string;
  email?: string;
  passwordHash: string;
  passwordChangedAt?: Date | null;
  avatarUrl?: string | null;
  avatarPublicId?: string | null;
  isVerified: boolean;
  isBanned: boolean;
  bannedAt?: Date | null;
  bannedUntil?: Date | null;
  banReason?: string | null;
  banAppeal?: string | null;
  appealAt?: Date | null;
  appealResolvedAt?: Date | null;
  deletedAt?: Date | null;
  isDeleted: boolean;
  appealStatus: 'none' | 'pending' | 'rejected';
  showUnbanMessage: boolean;
  role: 'user' | 'admin';
  spotify?: {
    spotifyId?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    isPremium?: boolean;
    profilePictureUrl?: string | null;
  };
  google?: {
    googleId?: string | null;
    email?: string | null;
    name?: string | null;
    pictureUrl?: string | null;
  };
  lastIp?: string | null;
  bio: string;
  deviceIds: string[];
  createdAt?: Date;
  updatedAt?: Date;

  verifyPassword(plain: string): Promise<boolean>;
  toPublic(): Record<string, unknown>;
  checkBanStatus(): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {
  hashPassword(plain: string): Promise<string>;
}

const userSchema = new mongoose.Schema<IUser>(
  {
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: false,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: /^[a-zA-Z0-9_.-]+$/,
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
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
    isBanned: {
      type: Boolean,
      default: false,
    },
    bannedUntil: {
      type: Date,
      default: null,
    },
    banReason: {
      type: String,
      default: null,
      maxlength: 500,
    },
    banAppeal: {
      type: String,
      default: null,
      maxlength: 1000,
    },
    appealAt: {
      type: Date,
      default: null,
    },
    appealResolvedAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    appealStatus: {
      type: String,
      enum: ['none', 'pending', 'rejected'],
      default: 'none',
    },
    showUnbanMessage: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    spotify: {
      spotifyId: { type: String, default: null },
      accessToken: { type: String, default: null },
      refreshToken: { type: String, default: null },
      expiresAt: { type: Date, default: null },
      isPremium: { type: Boolean, default: false },
      profilePictureUrl: { type: String, default: null },
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
    deviceIds: {
      type: [String],
      default: [],
      index: true,
    },
  },
  { timestamps: true, collection: 'users' }
);

// At least one identifier required
userSchema.pre('validate', function (this: IUser, next: mongoose.CallbackWithoutResultAndOptionalError) {
  if (!this.username && !this.email) {
    return next(new Error('Either username or email is required'));
  }
  next();
});

// Prevent duplicate Google account links
userSchema.index({ 'google.googleId': 1 }, { unique: true, sparse: true });

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
    username: this.username,
    email: this.email,
    avatarUrl: this.avatarUrl,
    bio: this.bio || '',
    isVerified: this.isVerified,
    isBanned: this.isBanned,
    ...(this.isBanned ? {
      bannedUntil: this.bannedUntil,
      banReason: this.banReason,
      appealStatus: this.appealStatus,
      banAppeal: this.banAppeal,
    } : {}),
    showUnbanMessage: this.showUnbanMessage,
    role: this.role,
    createdAt: this.createdAt,
    passwordChangedAt: this.passwordChangedAt,
    hasPassword: this.passwordHash !== 'OAUTH_NO_PASSWORD',
    spotify: this.spotify ? {
      connected: !!this.spotify.spotifyId,
      spotifyId: this.spotify.spotifyId || null,
      isPremium: this.spotify.isPremium || false,
      profilePictureUrl: this.spotify.profilePictureUrl || null,
    } : null,
    google: this.google?.googleId ? {
      connected: true,
      googleId: this.google.googleId,
      email: this.google.email,
      name: this.google.name,
      pictureUrl: this.google.pictureUrl,
    } : { connected: false }
  };
};

/**
 * Checks if the user's ban has expired.
 * If expired, it resets the ban fields and returns true (unbanned).
 * Returns false if still banned or was never banned.
 */
userSchema.methods.checkBanStatus = async function (this: IUser): Promise<boolean> {
  if (!this.isBanned) return false;

  if (this.bannedUntil && this.bannedUntil <= new Date()) {
    this.isBanned = false;
    (this as any).bannedAt = null;
    this.bannedUntil = null;
    this.banReason = null;
    this.banAppeal = null;
    this.appealAt = null;
    this.appealStatus = 'none';
    this.showUnbanMessage = true;
    await this.save();
    return true;
  }

  return false;
};

export default mongoose.model<IUser, IUserModel>('User', userSchema);