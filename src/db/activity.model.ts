import mongoose from 'mongoose';

export type ActivityType =
  | 'project_published'
  | 'project_starred'
  | 'project_forked'
  | 'project_boosted'
  | 'playlist_created'
  | 'user_followed';

export interface IActivity {
  actorId: mongoose.Types.ObjectId;
  type: ActivityType;
  projectId: string;
  projectTitle: string;
  coverImage: string;
  targetPath: string;
  createdAt: Date;
}

const activitySchema = new mongoose.Schema<IActivity>(
  {
    actorId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type:         {
      type: String,
      enum: [
        'project_published', 'project_starred', 'project_forked',
        'project_boosted', 'playlist_created', 'user_followed',
      ],
      required: true,
    },
    projectId:    { type: String, default: '' },
    projectTitle: { type: String, default: '' },
    coverImage:   { type: String, default: '' },
    targetPath:   { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'activities' }
);

activitySchema.index({ actorId: 1, createdAt: -1 });
activitySchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days TTL

export default mongoose.model<IActivity>('Activity', activitySchema);
