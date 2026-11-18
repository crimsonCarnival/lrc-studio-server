import mongoose, { type Document, type Model } from 'mongoose';

/** An admin's "not an album worth cataloguing" verdict on a detected title, per artist. */
export interface ICatalogAlbumDismissal extends Document {
  artistId: mongoose.Types.ObjectId;
  /** `albumKey(title)`, same normalization as catalog album keys. */
  titleKey: string;
  dismissedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const catalogAlbumDismissalSchema = new mongoose.Schema<ICatalogAlbumDismissal>(
  {
    artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogArtist', required: true },
    titleKey: { type: String, required: true, maxlength: 500 },
    dismissedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'catalog_album_dismissals' }
);

catalogAlbumDismissalSchema.index({ artistId: 1, titleKey: 1 }, { unique: true });

const CatalogAlbumDismissal: Model<ICatalogAlbumDismissal> = mongoose.model('CatalogAlbumDismissal', catalogAlbumDismissalSchema);
export default CatalogAlbumDismissal;
