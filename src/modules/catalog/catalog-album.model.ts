import mongoose, { type Document, type Model } from 'mongoose';
import { CATALOG_SOURCES, CATALOG_STATUSES, type CatalogSource, type CatalogStatus } from './catalog.types.js';

/** A canonical album under a `CatalogArtist`. Slug is null until approval. */
export interface ICatalogAlbum extends Document {
  artistId: mongoose.Types.ObjectId;
  title: string;
  /** `artistKey(title.trim())`, same normalization as shelf album keys. */
  titleKey: string;
  slug: string | null;
  year: string | null;
  coverUrl: string | null;
  status: CatalogStatus;
  source: CatalogSource;
  submittedBy: mongoose.Types.ObjectId;
  reviewedBy: mongoose.Types.ObjectId | null;
  reviewNote: string;
  reviewedAt: Date | null;
  creditAwarded: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const catalogAlbumSchema = new mongoose.Schema<ICatalogAlbum>(
  {
    artistId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogArtist', required: true },
    title: { type: String, required: true, maxlength: 500 },
    titleKey: { type: String, required: true, maxlength: 500 },
    slug: { type: String, default: null },
    year: { type: String, default: null, maxlength: 4 },
    coverUrl: { type: String, default: null },
    status: { type: String, enum: CATALOG_STATUSES, required: true },
    source: { type: String, enum: CATALOG_SOURCES, required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    creditAwarded: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'catalog_albums' }
);

catalogAlbumSchema.index({ artistId: 1, slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: 'string' } } });
catalogAlbumSchema.index({ artistId: 1, titleKey: 1, status: 1 });
catalogAlbumSchema.index({ status: 1, createdAt: 1 });
catalogAlbumSchema.index({ submittedBy: 1, createdAt: -1 });

const CatalogAlbum: Model<ICatalogAlbum> = mongoose.model('CatalogAlbum', catalogAlbumSchema);
export default CatalogAlbum;
