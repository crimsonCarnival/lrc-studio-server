import mongoose, { type Document, type Model } from "mongoose";
import argon2 from "argon2";
import { ROLES, type Role } from "../shared/permissions.js";

// Argon2id parameters — OWASP recommended minimums for interactive logins.
// Argon2id is the hybrid variant: resistant to GPU/ASIC brute-force AND
// side-channel attacks.
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MB — OWASP minimum; 64 MB caused OOM in constrained envs
  timeCost: 3, // 3 iterations
  parallelism: 1, // 1 thread — avoids CPU contention on multi-tenant servers
};

export interface IBan {
  active: boolean;
  reason?: string | null;
  until?: Date | null;
}

export interface IShadowBan {
  feed: boolean;
  search: boolean;
  reason: string | null;
  appliedAt: Date | null;
  appliedBy: mongoose.Types.ObjectId | null;
}

export interface IAppeal {
  text?: string | null;
  status: "none" | "pending" | "rejected";
  submittedAt?: Date | null;
  resolvedAt?: Date | null;
}

export interface ISocial {
  followerCount: number;
  followingCount: number;
  totalStarsReceived: number;
  totalForksReceived: number;
}

export interface IUserBadge {
  id: string;
  grantedAt: Date;
  grantedBy: string;
}

export interface IMusicLibraryEntry {
  artist: string;
  album: string;
  genre?: string;
  language?: string;
  trackCount?: number | null;
  updatedAt: Date;
}

export interface IUserStats {
  minutesSynced: number;
  secondsSynced: number;
  wordsSynced: number;
  karaokeLines: number;
  syncedLines: number;
  // Lines whose timestamp was set by ASR auto-stamp (not manually synced)
  aiSyncedLines: number;
  aiWordsSynced: number;
}

export interface IUserStreak {
  current: number;
  longest: number;
  lastActiveDate?: Date | null;
  // UTC day ('YYYY-MM-DD') for which the streak-ending warning was already
  // sent. Makes the streak-warning job idempotent across runs and restarts.
  warnedFor?: string | null;
}

export interface IUserProgression {
  xp: number;
  level: number;
  // Manual admin XP adjustments, kept separate from the derived total.
  //
  // `progression.xp` is DERIVED: recomputeXP() recalculates it from badges +
  // stats + social on every badge grant/revoke (including auto-grants from
  // triggerBadgeCheck) and overwrites whatever was there. An admin grant that
  // only touched `progression.xp` was therefore erased the next time the user
  // earned or lost a badge. Admin adjustments accumulate here instead, and
  // computeXPFromStats() folds `bonusXp` into the derived total, so they
  // survive every recompute. Intentionally unsigned-free (no `min`): a revoke
  // must be able to push the bonus negative to offset derived XP.
  bonusXp: number;
  // Written by logXPEvent()/recomputeXP() for indexing and audit ordering.
  lastXpEventAt?: Date | null;
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
  role: Role;
  permissions: string[];
  google?: {
    googleId?: string | null;
    email?: string | null;
    name?: string | null;
    pictureUrl?: string | null;
  };
  social?: ISocial;
  lastActiveDate?: Date | null;
  lastOnlineAt?: Date | null;
  lastIp?: string | null;
  bio: string;
  currentChallenge?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  // Stats subdoc
  stats?: IUserStats;
  statsComputedAt?: Date | null;
  // Streak subdoc
  streak?: IUserStreak;
  // Badges
  badges: IUserBadge[];
  showcasedBadges: string[];
  showcasePublic: boolean;
  // Music library: previously used artists/albums for autofill
  musicLibrary: IMusicLibraryEntry[];
  // Progression subdoc
  progression?: IUserProgression;
  // Shadow ban subdoc (admin-only, never exposed to users)
  shadowBan?: IShadowBan;
  // Denormalized count of projects owned by this user. Needed because the
  // leaderboard sorts by it and a per-user Project aggregation cannot be
  // index-sorted or paginated. Kept live by $inc on project create/clone/delete
  // and reconciled hourly by the leaderboard-ranking job, which already
  // aggregates the authoritative counts.
  projectCount?: number;

  verifyPassword(plain: string): Promise<boolean>;
  toPublic(): Record<string, unknown>;
  checkBanStatus(): Promise<boolean>;
  // Computed ranking score (0–1000), updated hourly by leaderboard-ranking job
  rankScore?: number;
}

export interface IUserModel extends Model<IUser> {
  hashPassword(plain: string): Promise<string>;
}

const shadowBanSchema = new mongoose.Schema<IShadowBan>({
  feed:      { type: Boolean, default: false },
  search:    { type: Boolean, default: false },
  reason:    { type: String, default: null },
  appliedAt: { type: Date, default: null },
  appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { _id: false });

const banSchema = new mongoose.Schema<IBan>(
  {
    active: { type: Boolean, default: false },
    reason: { type: String, default: null, maxlength: 500 },
    until: { type: Date, default: null },
  },
  { _id: false },
);

const appealSchema = new mongoose.Schema<IAppeal>(
  {
    text: { type: String, default: null, maxlength: 1000 },
    status: {
      type: String,
      enum: ["none", "pending", "rejected"],
      default: "none",
    },
    submittedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { _id: false },
);

const socialSchema = new mongoose.Schema<ISocial>(
  {
    followerCount: { type: Number, default: 0, min: 0 },
    followingCount: { type: Number, default: 0, min: 0 },
    totalStarsReceived: { type: Number, default: 0, min: 0 },
    totalForksReceived: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const userBadgeSchema = new mongoose.Schema<IUserBadge>(
  {
    id: { type: String, required: true },
    grantedAt: { type: Date, default: Date.now },
    grantedBy: { type: String, default: "system" },
  },
  { _id: false },
);

const statsSchema = new mongoose.Schema<IUserStats>(
  {
    minutesSynced: { type: Number, default: 0, min: 0 },
    secondsSynced: { type: Number, default: 0, min: 0 },
    wordsSynced: { type: Number, default: 0, min: 0 },
    karaokeLines: { type: Number, default: 0, min: 0 },
    syncedLines: { type: Number, default: 0, min: 0 },
    aiSyncedLines: { type: Number, default: 0, min: 0 },
    aiWordsSynced: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const streakSchema = new mongoose.Schema<IUserStreak>(
  {
    current: { type: Number, default: 0, min: 0 },
    longest: { type: Number, default: 0, min: 0 },
    lastActiveDate: { type: Date, default: null },
    warnedFor: { type: String, default: null },
  },
  { _id: false },
);

const progressionSchema = new mongoose.Schema<IUserProgression>(
  {
    xp: { type: Number, default: 0, min: 0 },
    level: { type: Number, default: 0, min: 0 },
    // No `min` — see IUserProgression.bonusXp: revokes may drive it negative.
    bonusXp: { type: Number, default: 0 },
    // logXPEvent() and recomputeXP() have always written this path, but it was
    // never declared here, so Mongoose strict mode silently dropped it and any
    // reader got `undefined`. Declared so those writes actually land.
    lastXpEventAt: { type: Date, default: null },
  },
  { _id: false },
);

const musicLibraryEntrySchema = new mongoose.Schema<IMusicLibraryEntry>(
  {
    artist: { type: String, default: "", maxlength: 500 },
    album: { type: String, default: "", maxlength: 500 },
    genre: { type: String, default: "", maxlength: 100 },
    language: { type: String, default: "", maxlength: 100 },
    trackCount: { type: Number, default: null, min: 0, max: 999 },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
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
    lastOnlineAt: {
      type: Date,
      default: null,
    },
    role: {
      type: String,
      enum: ROLES,
      default: "user",
    },
    // Authoritative authorization set. Seeded from ROLE_PRESETS when a role is
    // assigned; checked directly by guards. Role itself grants nothing.
    permissions: {
      type: [String],
      default: [],
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
      default: "",
      maxlength: 160,
    },
    social: { type: socialSchema, default: () => ({}) },
    currentChallenge: {
      type: String,
      default: null,
    },
    stats: { type: statsSchema, default: () => ({}) },
    statsComputedAt: { type: Date, default: null },
    streak: { type: streakSchema, default: () => ({}) },
    badges: { type: [userBadgeSchema], default: [] },
    showcasedBadges: { type: [String], default: [] },
    showcasePublic: { type: Boolean, default: true },
    progression: { type: progressionSchema, default: () => ({}) },
    musicLibrary: {
      type: [musicLibraryEntrySchema],
      default: [],
      _id: false,
    },
    shadowBan: { type: shadowBanSchema, default: () => ({ feed: false, search: false, reason: null, appliedAt: null, appliedBy: null }) },
    // Computed weighted-percentile score (0–1000), written by leaderboard-ranking job hourly
    rankScore: { type: Number, default: 0, min: 0 },
    // Denormalized owned-project count — see IUser.projectCount
    projectCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, collection: "users" },
);

// At least one identifier required
userSchema.pre(
  "validate",
  function (this: IUser, next: mongoose.CallbackWithoutResultAndOptionalError) {
    if (!this.accountName && !this.email) {
      return next(new Error("Either accountName or email is required"));
    }
    next();
  },
);

// Prevent duplicate Google account links.
//
// This must be a PARTIAL index, not a sparse one. `sparse` only skips documents
// where the field is absent — it still indexes explicit nulls. Since
// `google.googleId` has `default: null`, Mongoose materialises the field on
// every user, so a sparse unique index lets exactly one account hold null and
// rejects every password registration after that with a duplicate-key 500.
userSchema.index(
  { "google.googleId": 1 },
  { unique: true, partialFilterExpression: { "google.googleId": { $type: "string" } } },
);

// Enables $text search in admin user listing
userSchema.index({ accountName: "text", email: "text" });

// Soft-delete filter support
userSchema.index({ isDeleted: 1 });

// Streak-warning job: range scan over users last active yesterday (UTC)
userSchema.index({ "streak.lastActiveDate": 1 });

// ─── Leaderboard sort indexes ────────────────────────────────────────────────
//
// One index per sortable leaderboard column. Key order mirrors the resolver's
// sort exactly so the sort is index-provided rather than a blocking in-memory
// sort, and every one ends the sort portion with `_id` because the resolver
// appends `_id` as the final tiebreak — without it, offset pagination over
// equal values is non-deterministic and rows can duplicate or vanish between
// pages.
//
// `isDeleted` trails each one *after* `_id`: it is not part of the sort (so it
// cannot disturb the index-provided ordering, which only requires the sort keys
// to be a prefix) but it lets the `isDeleted: { $ne: true }` filter be answered
// from the index key instead of fetching every document.
//
// A single index serves both sort directions, because `sortDir: ASC` reverses
// *every* key including the `_id` tiebreak, which is exactly a backward scan of
// the same index. That is why there is one index per column, not two.
userSchema.index({ rankScore: -1, 'stats.syncedLines': -1, _id: 1, isDeleted: 1 });
userSchema.index({ 'progression.xp': -1, _id: 1, isDeleted: 1 });
userSchema.index({ projectCount: -1, _id: 1, isDeleted: 1 });
userSchema.index({ 'stats.syncedLines': -1, _id: 1, isDeleted: 1 });
userSchema.index({ 'social.totalStarsReceived': -1, _id: 1, isDeleted: 1 });
// secondsSynced is always 0..59 (recomputeSyncStats stores the remainder), so
// (minutesSynced, secondsSynced) is equivalent to a sort by total seconds.
userSchema.index({ 'stats.minutesSynced': -1, 'stats.secondsSynced': -1, _id: 1, isDeleted: 1 });

userSchema.methods.verifyPassword = async function (
  this: IUser,
  plain: string,
): Promise<boolean> {
  if (this.passwordHash === "OAUTH_NO_PASSWORD") return false;
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
    bio: this.bio || "",
    isVerified: this.isVerified,
    ban: {
      active: this.ban?.active ?? false,
      ...(this.ban?.active
        ? { reason: this.ban.reason, until: this.ban.until }
        : {}),
    },
    appeal: this.ban?.active
      ? {
          text: this.appeal?.text ?? null,
          status: this.appeal?.status ?? "none",
          submittedAt: this.appeal?.submittedAt ?? null,
          resolvedAt: this.appeal?.resolvedAt ?? null,
        }
      : null,
    role: this.role,
    permissions: this.permissions ?? [],
    createdAt: this.createdAt,
    passwordChangedAt: this.passwordChangedAt,
    lastAccountNameChangedAt: this.lastAccountNameChangedAt ?? null,
    hasPassword: this.passwordHash !== "OAUTH_NO_PASSWORD",
    google: this.google?.googleId
      ? {
          connected: true,
          googleId: this.google.googleId,
          email: this.google.email,
          name: this.google.name,
          pictureUrl: this.google.pictureUrl,
        }
      : { connected: false },
    badges: this.badges ?? [],
    showcasedBadges: this.showcasedBadges ?? [],
    showcasePublic: this.showcasePublic ?? true,
    stats: {
      minutesSynced: this.stats?.minutesSynced ?? 0,
      secondsSynced: this.stats?.secondsSynced ?? 0,
      wordsSynced: this.stats?.wordsSynced ?? 0,
      karaokeLines: this.stats?.karaokeLines ?? 0,
      syncedLines: this.stats?.syncedLines ?? 0,
    },
    streak: {
      current: this.streak?.current ?? 0,
      longest: this.streak?.longest ?? 0,
      lastActiveDate: this.streak?.lastActiveDate ?? null,
    },
    progression: {
      xp: this.progression?.xp ?? 0,
      level: this.progression?.level ?? 0,
    },
  };
};

/**
 * Checks if the user's ban has expired.
 * If expired, clears the ban and appeal state.
 * Returns true so the caller knows to surface a wasJustUnbanned signal.
 */
userSchema.methods.checkBanStatus = async function (
  this: IUser,
): Promise<boolean> {
  if (!this.ban?.active) return false;

  if (this.ban.until && this.ban.until <= new Date()) {
    this.ban.active = false;
    this.ban.reason = null;
    this.ban.until = null;
    this.appeal.text = null;
    this.appeal.status = "none";
    this.appeal.submittedAt = null;
    await this.save();
    return true;
  }

  return false;
};

export default mongoose.model<IUser, IUserModel>("User", userSchema);
