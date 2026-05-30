import mongoose from 'mongoose';

export interface IPlaylist {
  owner: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  coverImage?: string;
  tags: string[];
  isPublic: boolean;
  sortMode: 'MANUAL' | 'DATE_ADDED' | 'STARS' | 'ALPHABETICAL';
  projectIds: mongoose.Types.ObjectId[];
  savedCount: number;
  trendingScore: number;
  createdAt: Date;
  updatedAt: Date;
}

const playlistSchema = new mongoose.Schema<IPlaylist>(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 100 },
    description: { type: String, maxlength: 500 },
    coverImage: { type: String },
    tags: { type: [String], default: [] },
    isPublic: { type: Boolean, default: true },
    sortMode: {
      type: String,
      enum: ['MANUAL', 'DATE_ADDED', 'STARS', 'ALPHABETICAL'],
      default: 'DATE_ADDED',
    },
    projectIds: { type: [mongoose.Schema.Types.ObjectId], ref: 'Project', default: [] },
    savedCount: { type: Number, default: 0 },
    trendingScore: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'playlists' }
);

playlistSchema.index({ owner: 1 });
playlistSchema.index({ tags: 1 });
playlistSchema.index({ isPublic: 1, trendingScore: -1 });

export default mongoose.model<IPlaylist>('Playlist', playlistSchema);
