import mongoose from 'mongoose';
import { stripHtml, sanitizeUrl } from '../../utils/sanitize.js';

const textSetter = (v: unknown) => (typeof v === 'string' ? stripHtml(v) : v);
const urlSetter = (v: unknown) => sanitizeUrl(v as string);

export interface IUpload {
  userId?: mongoose.Types.ObjectId | null;
  source: 'cloudinary' | 'youtube' | 'spotify';
  uploadUrl?: string | null;
  publicId?: string | null;
  spotifyTrackId?: string | null;
  fileName: string;
  title: string;
  duration?: number | null;
  coverImage?: string | null;
}

export interface IUploadMethods {
  toPublic(): Record<string, unknown>;
}

type UploadModel = mongoose.Model<IUpload, Record<string, never>, IUploadMethods>;

const uploadSchema = new mongoose.Schema<IUpload, UploadModel, IUploadMethods>(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    source: {
      type: String,
      enum: ['cloudinary', 'youtube', 'spotify'],
      required: true,
    },
    uploadUrl: { type: String, default: null, maxlength: 500, set: urlSetter },
    publicId: { type: String, default: null, maxlength: 500 },
    spotifyTrackId: { type: String, default: null, maxlength: 100 },
    fileName: { type: String, default: '', maxlength: 500, set: textSetter },
    title: { type: String, default: '', maxlength: 500, set: textSetter },
    duration: { type: Number, default: null },
    coverImage: { type: String, default: null, maxlength: 2000, set: urlSetter },
  },
  { timestamps: true, collection: 'uploads' }
);

uploadSchema.index({ userId: 1, source: 1, uploadUrl: 1 }, { sparse: true });
uploadSchema.index({ userId: 1, source: 1, spotifyTrackId: 1 }, { sparse: true });
uploadSchema.index({ userId: 1, updatedAt: -1 });
uploadSchema.index({ publicId: 1 }, { sparse: true });

uploadSchema.methods.toPublic = function (this: mongoose.Document & IUpload) {
  const obj = this.toObject();
  delete obj.__v;
  obj.id = obj._id.toString();
  delete obj._id;
  return obj;
};

export default mongoose.model<IUpload, UploadModel>('Upload', uploadSchema);