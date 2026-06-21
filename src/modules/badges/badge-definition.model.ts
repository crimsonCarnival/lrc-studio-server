import mongoose from 'mongoose';

export type ConditionType =
  | 'registration_rank'
  | 'minutes_synced'
  | 'words_synced'
  | 'karaoke_lines'
  | 'project_count'
  | 'public_project_count'
  | 'stars_received'
  | 'forks_received'
  | 'follower_count'
  | 'upload_count'
  | 'account_age_days'
  | 'streak_days'
  | 'is_verified'
  | 'role_admin'
  | 'manual';

export type BadgeColor = 'amber' | 'teal' | 'green' | 'primary' | 'rose' | 'shimmer' | 'blue' | 'orange';

export interface LocalizedString {
  en: string;
  es: string;
}

export interface IBadgeDefinition {
  id: string;
  label: LocalizedString;
  description: LocalizedString;
  icon: string;
  color: BadgeColor;
  conditionType: ConditionType;
  conditionValue: number | null;
  autoGrant: boolean;
  isBuiltin: boolean;
  xpReward: number;
  createdBy: mongoose.Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const badgeDefSchema = new mongoose.Schema<IBadgeDefinition>(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_-]+$/,
      maxlength: 40,
    },
    label: {
      en: { type: String, required: true, trim: true, maxlength: 50 },
      es: { type: String, default: '', trim: true, maxlength: 50 }
    },
    description: {
      en: { type: String, default: '', maxlength: 200 },
      es: { type: String, default: '', maxlength: 200 }
    },
    icon: { type: String, default: '', maxlength: 10 },
    color: {
      type: String,
      enum: ['amber', 'teal', 'green', 'primary', 'rose', 'shimmer', 'blue', 'orange'],
      default: 'primary',
    },
    conditionType: {
      type: String,
      enum: ['registration_rank', 'minutes_synced', 'words_synced', 'karaoke_lines', 'project_count', 'public_project_count', 'stars_received', 'forks_received', 'follower_count', 'upload_count', 'account_age_days', 'streak_days', 'is_verified', 'role_admin', 'manual'],
      default: 'manual',
    },
    conditionValue: { type: Number, default: null },
    autoGrant: { type: Boolean, default: false },
    isBuiltin: { type: Boolean, default: false },
    xpReward: { type: Number, default: 50, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'badge_definitions' }
);

export default mongoose.model<IBadgeDefinition>('BadgeDefinition', badgeDefSchema);
