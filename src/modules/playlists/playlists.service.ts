import mongoose from 'mongoose';
import Playlist from './playlist.model.js';
import SavedPlaylist from './saved-playlist.model.js';

/** Deletes a playlist and everyone's saves of it. The caller has checked who may. */
export async function removePlaylist(id: string | mongoose.Types.ObjectId): Promise<void> {
  const playlistId = new mongoose.Types.ObjectId(String(id));
  await SavedPlaylist.deleteMany({ playlistId });
  await Playlist.deleteOne({ _id: playlistId });
}

/**
 * A moderator deletes someone else's playlist (after a report). The caller checks the
 * moderator's permission, sudo grant and rank. False when it's already gone.
 */
export async function deletePlaylistAsModerator(id: string): Promise<boolean> {
  if (!mongoose.isValidObjectId(id)) return false;
  if (!(await Playlist.exists({ _id: id }))) return false;
  await removePlaylist(id);
  return true;
}
