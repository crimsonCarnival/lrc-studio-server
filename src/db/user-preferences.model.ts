import mongoose from 'mongoose';

export interface INotificationPrefs {
  follow: boolean;
  reaction: boolean;
  star: boolean;
  fork: boolean;
  badge_awarded: boolean;
  xp_changed: boolean;
}

export interface IUserPreferences {
  userId: mongoose.Types.ObjectId;
  showFollowers: boolean;
  onlineVisibility: 'everyone' | 'friends' | 'nobody';
  miniProfileBadgesEnabled: boolean;
  miniProfileBadgeIds: string[];
  notifications: INotificationPrefs;
}

const notifPrefsSchema = new mongoose.Schema<INotificationPrefs>({
  follow:        { type: Boolean, default: true },
  reaction:      { type: Boolean, default: true },
  star:          { type: Boolean, default: true },
  fork:          { type: Boolean, default: true },
  badge_awarded: { type: Boolean, default: true },
  xp_changed:    { type: Boolean, default: true },
}, { _id: false });

const userPreferencesSchema = new mongoose.Schema<IUserPreferences>({
  userId:                   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  showFollowers:            { type: Boolean, default: true },
  onlineVisibility:         { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'friends' },
  miniProfileBadgesEnabled: { type: Boolean, default: true },
  miniProfileBadgeIds:      { type: [String], default: [] },
  notifications:            { type: notifPrefsSchema, default: () => ({}) },
}, { timestamps: true, collection: 'user_preferences' });

export default mongoose.model<IUserPreferences>('UserPreferences', userPreferencesSchema);
