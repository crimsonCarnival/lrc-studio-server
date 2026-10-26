import mongoose from 'mongoose';

export interface ISavedPlaylist {
  userId: mongoose.Types.ObjectId;
  playlistId: mongoose.Types.ObjectId;
  savedAt: Date;
}

const savedPlaylistSchema = new mongoose.Schema<ISavedPlaylist>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    playlistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Playlist', required: true },
    savedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: false, collection: 'saved_playlists' }
);

savedPlaylistSchema.index({ userId: 1, playlistId: 1 }, { unique: true });
savedPlaylistSchema.index({ playlistId: 1 });

export default mongoose.model<ISavedPlaylist>('SavedPlaylist', savedPlaylistSchema);
