import mongoose, { type Document, type Model } from 'mongoose';

/**
 * Owner-chosen visibility of an artist (`albumKey: null`) or one of its albums
 * on the profile shelf. No row means private.
 */
export interface IShelfVisibility extends Document {
  userId: mongoose.Types.ObjectId;
  artistId: mongoose.Types.ObjectId;
  /** null = the artist row; '' = the singles bucket; otherwise an album key. */
  albumKey: string | null;
  isPublic: boolean;
}

const shelfVisibilitySchema = new mongoose.Schema<IShelfVisibility>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Artist', required: true },
    albumKey: { type: String, default: null, maxlength: 500 },
    isPublic: { type: Boolean, required: true },
  },
  { timestamps: true, collection: 'artist_shelf_visibility' }
);

shelfVisibilitySchema.index({ userId: 1, artistId: 1, albumKey: 1 }, { unique: true });

const ShelfVisibility: Model<IShelfVisibility> = mongoose.model('ShelfVisibility', shelfVisibilitySchema);
export default ShelfVisibility;
