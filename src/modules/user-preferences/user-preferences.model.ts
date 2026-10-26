import mongoose from 'mongoose';

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
  level_up: boolean;
  playlist_saved: boolean;
  star_milestone: boolean;
  new_device: boolean;
  appeal_result: boolean;
}

export interface IUserPreferences {
  userId: mongoose.Types.ObjectId;
  showFollowers: boolean;
  onlineVisibility: 'everyone' | 'friends' | 'nobody';
  lastOnlineVisibility: 'everyone' | 'friends' | 'nobody';
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
  level_up: { type: Boolean, default: true },
  playlist_saved: { type: Boolean, default: true },
  star_milestone: { type: Boolean, default: true },
  new_device: { type: Boolean, default: true },
  appeal_result: { type: Boolean, default: true },
}, { _id: false });

const userPreferencesSchema = new mongoose.Schema<IUserPreferences>({
  userId:                   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  showFollowers:            { type: Boolean, default: true },
  onlineVisibility:         { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'friends' },
  lastOnlineVisibility:     { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'friends' },
  countryVisibility:        { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'nobody' },
  defaultProjectPrivacy:    { type: String, enum: ['public', 'private'], default: 'public' },
  miniProfileBadgesEnabled: { type: Boolean, default: true },
  miniProfileBadgeIds:      { type: [String], default: [] },
  showActivityHeatmap:      { type: Boolean, default: false },
  showXpProgress:           { type: Boolean, default: false },
  wallEnabled:              { type: Boolean, default: true },
  notifications:           { type: notifPrefsSchema, default: () => ({}) },
}, { timestamps: true, collection: 'user_preferences' });

export default mongoose.model<IUserPreferences>('UserPreferences', userPreferencesSchema);
