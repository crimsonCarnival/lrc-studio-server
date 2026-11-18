import mongoose, { type Document, type Model } from 'mongoose';
import { CATALOG_IMAGE_SOURCES, CATALOG_SOURCES, CATALOG_STATUSES, type CatalogImageSource, type CatalogSource, type CatalogStatus } from './catalog.types.js';

/**
 * A canonical, site-wide artist. Unlike the per-user `Artist` shelf, entries
 * here are shared and moderated. `slug` stays null until approval, so pending
 * and rejected entries reserve nothing and homonyms can coexist in the queue.
 */
export interface ICatalogArtist extends Document {
  name: string;
  /** `artistKey(name)`: the duplicate-check and suggestion key. */
  nameKey: string;
  slug: string | null;
  disambiguation: string;
  imageUrl: string | null;
  /** Where the photo came from; null when there is none (or for legacy entries). */
  imageSource: CatalogImageSource | null;
  /** The Genius page credited when imageSource is 'genius'. */
  imageSourceUrl: string | null;
  bio: string;
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

const catalogArtistSchema = new mongoose.Schema<ICatalogArtist>(
  {
    name: { type: String, required: true, maxlength: 300 },
    nameKey: { type: String, required: true, maxlength: 300 },
    slug: { type: String, default: null },
    disambiguation: { type: String, default: '', maxlength: 80 },
    imageUrl: { type: String, default: null },
    imageSource: { type: String, enum: CATALOG_IMAGE_SOURCES, default: null },
    imageSourceUrl: { type: String, default: null, maxlength: 512 },
    bio: { type: String, default: '', maxlength: 1000 },
    status: { type: String, enum: CATALOG_STATUSES, required: true },
    source: { type: String, enum: CATALOG_SOURCES, required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewNote: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    creditAwarded: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'catalog_artists' }
);

// Partial, not sparse: slug is stored as null on unslugged docs, and sparse
// indexes still index explicit nulls.
catalogArtistSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: 'string' } } });
catalogArtistSchema.index({ nameKey: 1, status: 1 });
catalogArtistSchema.index({ status: 1, createdAt: 1 });
catalogArtistSchema.index({ submittedBy: 1, createdAt: -1 });

const CatalogArtist: Model<ICatalogArtist> = mongoose.model('CatalogArtist', catalogArtistSchema);
export default CatalogArtist;
