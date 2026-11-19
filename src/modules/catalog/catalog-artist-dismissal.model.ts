import mongoose, { type Document, type Model } from 'mongoose';

/** An admin's "not an artist worth cataloguing" verdict on a detected name, site-wide. */
export interface ICatalogArtistDismissal extends Document {
  /** `artistKey(name)`, same normalization as catalog artist keys. */
  nameKey: string;
  dismissedBy: mongoose.Types.ObjectId;
  createdAt?: Date;
}

const catalogArtistDismissalSchema = new mongoose.Schema<ICatalogArtistDismissal>(
  {
    nameKey: { type: String, required: true, maxlength: 500 },
    dismissedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'catalog_artist_dismissals' }
);

catalogArtistDismissalSchema.index({ nameKey: 1 }, { unique: true });

const CatalogArtistDismissal: Model<ICatalogArtistDismissal> = mongoose.model('CatalogArtistDismissal', catalogArtistDismissalSchema);
export default CatalogArtistDismissal;
