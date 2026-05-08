import mongoose from 'mongoose';
import { stripHtml, sanitizeUrl } from '../../utils/sanitize.js';

const textSetter = (v: unknown) => (typeof v === 'string' ? stripHtml(v) : v);
const urlSetter = (v: unknown) => sanitizeUrl(v as string);

export interface IUpload {
  userId?: mongoose.Types.ObjectId | null;
  source: 'cloudinary' | 'youtube' | 'spotify';
  cloudinaryUrl?: string | null;
  publicId?: string | null;
  youtubeUrl?: string | null;
  spotifyTrackId?: string | null;
  artist?: string | null;
  fileName: string;
  title: string;
  duration?: number | null;
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
    cloudinaryUrl: { type: String, default: null, maxlength: 500, set: urlSetter },
    publicId: { type: String, default: null, maxlength: 500 },
    youtubeUrl: { type: String, default: null, maxlength: 500, set: urlSetter },
    spotifyTrackId: { type: String, default: null, maxlength: 100 },
    artist: { type: String, default: null, maxlength: 500, set: textSetter },
    fileName: { type: String, default: '', maxlength: 500, set: textSetter },
    title: { type: String, default: '', maxlength: 500, set: textSetter },
    duration: { type: Number, default: null },
  },
  { timestamps: true }
);

uploadSchema.index({ userId: 1, source: 1, cloudinaryUrl: 1 }, { sparse: true });
uploadSchema.index({ userId: 1, source: 1, youtubeUrl: 1 }, { sparse: true });
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