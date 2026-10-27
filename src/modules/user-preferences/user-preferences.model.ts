import mongoose from 'mongoose';

export const WALL_COMMENT_POLICIES = ['everyone', 'following', 'nobody'] as const;
export type WallCommentPolicy = (typeof WALL_COMMENT_POLICIES)[number];
/** new_accounts: accounts younger than a week. not_followed: anyone the owner doesn't follow. */
export const WALL_HOLD_POLICIES = ['nobody', 'new_accounts', 'not_followed', 'everyone'] as const;
export type WallHoldPolicy = (typeof WALL_HOLD_POLICIES)[number];
export const WALL_MUTED_WORDS_MAX = 50;
export const WALL_MUTED_WORD_MAX_LENGTH = 40;

export interface INotificationPrefs {
  follow: boolean;
  reaction: boolean;
  star: boolean;
  fork: boolean;
  badge_awarded: boolean;
  xp_changed: boolean;
  streak_warning: boolean;
  followed_project: boolean;
  wall_comment: boolean;
  mention: boolean;
  comment_like: boolean;
  level_up: boolean;
  playlist_saved: boolean;
  star_milestone: boolean;
  new_device: boolean;
  appeal_result: boolean;
  wall_report: boolean;
  wall_report_reviewed: boolean;
}

export interface IUserPreferences {
  userId: mongoose.Types.ObjectId;
  showFollowers: boolean;
  onlineVisibility: 'everyone' | 'friends' | 'nobody';
  lastOnlineVisibility: 'everyone' | 'friends' | 'nobody';
  /** ISO 3166-1 alpha-2, chosen by the user in settings; null when they haven't. */
  country: string | null;
  countryVisibility: 'everyone' | 'friends' | 'nobody';
  defaultProjectPrivacy: 'public' | 'private';
  miniProfileBadgesEnabled: boolean;
  miniProfileBadgeIds: string[];
  // Privacy-by-default: the activity heatmap reveals when a user is active,
  // so it is only exposed on the public profile after an explicit opt-in.
  showActivityHeatmap: boolean;
  // Also opt-in: the XP progress bar on the public profile. Level and XP totals stay public
  // where they already are (leaderboard), this only hides the progress bar.
  showXpProgress: boolean;
  // Whether other people can leave comments on this user's profile wall.
  wallEnabled: boolean;
  // Whether other people can tag this user in comments. Never limits whom they tag.
  allowTags: boolean;
  // Who may comment on this user's wall (the owner always may).
  wallWhoCanComment: WallCommentPolicy;
  // Whose comments wait for the owner's approval before others see them.
  wallHoldFrom: WallHoldPolicy;
  // Comments containing any of these (case-insensitive) are held for approval.
  wallMutedWords: string[];
  notifications: INotificationPrefs;
}

const notifPrefsSchema = new mongoose.Schema<INotificationPrefs>({
  follow:        { type: Boolean, default: true },
  reaction:      { type: Boolean, default: true },
  star:          { type: Boolean, default: true },
  fork:          { type: Boolean, default: true },
  badge_awarded: { type: Boolean, default: true },
  xp_changed:    { type: Boolean, default: true },
  streak_warning: { type: Boolean, default: true },
  followed_project: { type: Boolean, default: true },
  wall_comment: { type: Boolean, default: true },
  mention: { type: Boolean, default: true },
  comment_like: { type: Boolean, default: true },
  level_up: { type: Boolean, default: true },
  playlist_saved: { type: Boolean, default: true },
  star_milestone: { type: Boolean, default: true },
  new_device: { type: Boolean, default: true },
  appeal_result: { type: Boolean, default: true },
  wall_report: { type: Boolean, default: true },
  wall_report_reviewed: { type: Boolean, default: true },
}, { _id: false });

const userPreferencesSchema = new mongoose.Schema<IUserPreferences>({
  userId:                   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  showFollowers:            { type: Boolean, default: true },
  onlineVisibility:         { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'friends' },
  lastOnlineVisibility:     { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'friends' },
  country:                  { type: String, default: null, match: /^[A-Z]{2}$/ },
  countryVisibility:        { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'nobody' },
  defaultProjectPrivacy:    { type: String, enum: ['public', 'private'], default: 'public' },
  miniProfileBadgesEnabled: { type: Boolean, default: true },
  miniProfileBadgeIds:      { type: [String], default: [] },
  showActivityHeatmap:      { type: Boolean, default: false },
  showXpProgress:           { type: Boolean, default: false },
  wallEnabled:              { type: Boolean, default: true },
  allowTags:                { type: Boolean, default: true },
  wallWhoCanComment:        { type: String, enum: WALL_COMMENT_POLICIES, default: 'everyone' },
  wallHoldFrom:             { type: String, enum: WALL_HOLD_POLICIES, default: 'nobody' },
  wallMutedWords:           { type: [String], default: [] },
  notifications:           { type: notifPrefsSchema, default: () => ({}) },
}, { timestamps: true, collection: 'user_preferences' });

export default mongoose.model<IUserPreferences>('UserPreferences', userPreferencesSchema);
