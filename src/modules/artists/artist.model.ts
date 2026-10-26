import mongoose, { type Document, type Model } from 'mongoose';

/**
 * A name a user has credited on their songs. Scoped per user on purpose: it is
 * the autocomplete source for that user's own library, so nothing here is ever
 * readable by, or shared with, another account.
 */
export interface IArtist extends Document {
  userId: mongoose.Types.ObjectId;
  name: string;
  /** NFC + lower-cased `name`: the uniqueness and prefix-search key. */
  nameLower: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const artistSchema = new mongoose.Schema<IArtist>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 300 },
    nameLower: { type: String, required: true, maxlength: 300 },
  },
  { timestamps: true, collection: 'artists' }
);

// One record per (user, name, case-insensitively); also serves prefix search per user.
artistSchema.index({ userId: 1, nameLower: 1 }, { unique: true });

const Artist: Model<IArtist> = mongoose.model('Artist', artistSchema);
export default Artist;
