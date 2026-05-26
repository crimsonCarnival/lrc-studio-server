import { v2 as cloudinary } from 'cloudinary';
import { stripHtml } from '../../utils/sanitize.js';
import Upload from './upload.model.js';
import Project from '../projects/project.model.js';
import { fetchYouTubeTitle, fetchYouTubeMetadata } from '../../utils/youtube.js';
import { verifyRecaptcha } from '../auth/auth.service.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'webm', 'mp4'];
const UPLOAD_FOLDER = 'lyrics-syncer/audio';

export function isCloudinaryConfigured(): boolean {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

export async function generateAudioSignature(data: Record<string, unknown>, userId: string | null | undefined, ip: string): Promise<Record<string, unknown>> {
  if (!isCloudinaryConfigured()) {
    return { error: 'Upload service not configured', status: 503 };
  }

  const { fileName, fileSize, recaptchaToken } = data as { fileName: string; fileSize: number; recaptchaToken?: string };
  if (!(await verifyRecaptcha(recaptchaToken, ip))) {
    return { error: 'recaptcha_failed', status: 403 };
  }

  const sanitizedName = stripHtml(fileName);
  const ext = sanitizedName.split('.').pop()?.toLowerCase();

  if (!ext || !ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
    return {
      error: 'Invalid file type. Allowed: ' + ALLOWED_AUDIO_EXTENSIONS.join(', '),
      status: 400,
    };
  }

  if (fileSize > MAX_FILE_SIZE) {
    return { error: 'File too large. Max: ' + (MAX_FILE_SIZE / 1024 / 1024) + ' MB', status: 400 };
  }

  const apiSecret = process.env.CLOUDINARY_API_SECRET as string;
  const timestamp = Math.round(Date.now() / 1000);
  // Guests upload to a shared 'guests' folder; authenticated users get their own subfolder.
  const userFolder = userId ? `${UPLOAD_FOLDER}/${userId}` : `${UPLOAD_FOLDER}/guests`;
  const params = { timestamp, folder: userFolder };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);

  return {
    signature,
    timestamp,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    folder: userFolder,
    resourceType: 'video',
  };
}

export async function generateAvatarSignature(data: Record<string, unknown>, userId: string, ip: string): Promise<Record<string, unknown>> {
  if (!isCloudinaryConfigured()) {
    return { error: 'Upload service not configured', status: 503 };
  }

  const { fileSize, recaptchaToken } = data as { fileSize?: number; recaptchaToken?: string };
  if (!(await verifyRecaptcha(recaptchaToken, ip))) {
    return { error: 'recaptcha_failed', status: 403 };
  }

  if (fileSize && fileSize > 1 * 1024 * 1024) {
    return { error: 'Avatar file too large. Max: 1 MB', status: 400 };
  }

  const apiSecret = process.env.CLOUDINARY_API_SECRET as string;
  const timestamp = Math.round(Date.now() / 1000);
  const userFolder = 'lyrics-syncer/avatars/' + userId;
  const params = { 
    timestamp, 
    folder: userFolder,
    transformation: 'c_fill,w_256,h_256,f_auto,q_auto'
  };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);

  return {
    signature,
    timestamp,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    folder: userFolder,
    resourceType: 'image',
    transformation: 'c_fill,w_256,h_256,f_auto,q_auto',
  };
}

const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
const MAX_COVER_SIZE = 5 * 1024 * 1024;
const COVER_FOLDER = 'lyrics-syncer/covers';

export async function generateCoverSignature(data: Record<string, unknown>, userId: string, ip: string): Promise<Record<string, unknown>> {
  if (!isCloudinaryConfigured()) {
    return { error: 'Upload service not configured', status: 503 };
  }

  const { fileSize, fileName, recaptchaToken } = data as { fileSize?: number; fileName?: string; recaptchaToken?: string };
  if (!(await verifyRecaptcha(recaptchaToken, ip))) {
    return { error: 'recaptcha_failed', status: 403 };
  }

  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (!ext || !ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
      return { error: 'Invalid file type. Allowed: ' + ALLOWED_IMAGE_EXTENSIONS.join(', '), status: 400 };
    }
  }

  if (fileSize && fileSize > MAX_COVER_SIZE) {
    return { error: 'Image too large. Max: 5 MB', status: 400 };
  }

  const apiSecret = process.env.CLOUDINARY_API_SECRET as string;
  const timestamp = Math.round(Date.now() / 1000);
  const userFolder = `${COVER_FOLDER}/${userId}`;
  const params = { timestamp, folder: userFolder };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);

  return {
    signature,
    timestamp,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    folder: userFolder,
    resourceType: 'image',
  };
}

export async function listMedia(userId: string, { limit = 50, offset = 0 }: { limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const clampedLimit = Math.min(Math.max(1, Number(limit)), 100);
  const clampedOffset = Math.max(0, Number(offset));

  const total = await Upload.countDocuments({ userId });

  const uploads = await Upload.find({ userId })
    .sort({ updatedAt: -1 })
    .skip(clampedOffset)
    .limit(clampedLimit)
    .lean();

  return {
    uploads: uploads.map((u: Record<string, unknown>) => ({
      id: (u._id as Record<string, unknown>).toString(),
      source: u.source,
      cloudinaryUrl: u.cloudinaryUrl,
      publicId: u.publicId,
      youtubeUrl: u.youtubeUrl,
      spotifyTrackId: u.spotifyTrackId,
      artist: u.artist,
      fileName: u.fileName,
      title: u.title,
      duration: u.duration,
      createdAt: u.createdAt,
    })),
    total,
    hasMore: clampedOffset + uploads.length < total,
  };
}

export async function createMedia(userId: string | null | undefined, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { source, cloudinaryUrl, publicId, youtubeUrl, spotifyTrackId, artist, fileName, title, duration } = data as Record<string, string | undefined>;
  const query: Record<string, unknown> = { source };
  if (userId) query.userId = userId;
  else query.userId = null;

  if (source === 'youtube' && youtubeUrl) {
    const ytPattern = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|watch\?.+&v=)|youtu\.be\/)([^&?/\s]{11})/;
    const isId = /^[a-zA-Z0-9_-]{11}$/.test(youtubeUrl);
    if (!ytPattern.test(youtubeUrl) && !isId) {
      throw new Error('Invalid YouTube URL');
    }
    query.youtubeUrl = youtubeUrl;
  } else if (source === 'cloudinary' && cloudinaryUrl) {
    if (!cloudinaryUrl.startsWith('https://res.cloudinary.com/')) {
      throw new Error('Cloudinary URL must come from res.cloudinary.com');
    }
    const ourCloudName = process.env.CLOUDINARY_CLOUD_NAME;
    if (ourCloudName && !cloudinaryUrl.includes('/' + ourCloudName + '/')) {
      throw new Error('CDN URL does not belong to this application\'s Cloudinary account');
    }
    if (fileName) {
      const fileExt = fileName.split('.').pop()?.toLowerCase();
      if (fileExt && fileExt.length <= 5 && !ALLOWED_AUDIO_EXTENSIONS.includes(fileExt)) {
        throw new Error('Invalid audio file type');
      }
    }
    if (publicId) {
      if (!publicId.startsWith(UPLOAD_FOLDER + '/' + userId + '/') && !publicId.startsWith(UPLOAD_FOLDER + '/')) {
        throw new Error('Invalid Cloudinary public ID');
      }
    }
    query.cloudinaryUrl = cloudinaryUrl;
  } else if (source === 'spotify' && spotifyTrackId) {
    query.spotifyTrackId = spotifyTrackId;
  }

  let finalTitle = (title as string) || (fileName as string) || '';
  let finalDuration = duration ? Number(duration) : null;
  if (source === 'youtube' && youtubeUrl && (!title || !duration)) {
    const metadata = await fetchYouTubeMetadata(youtubeUrl);
    if (metadata) {
      if (!title && metadata.title) finalTitle = metadata.title;
      if (!duration && metadata.duration) finalDuration = metadata.duration;
    }
  }

  const upload = await Upload.findOneAndUpdate(
    query,
    {
      userId: userId || null,
      source,
      cloudinaryUrl: cloudinaryUrl || null,
      publicId: publicId || null,
      youtubeUrl: youtubeUrl || null,
      spotifyTrackId: spotifyTrackId || null,
      artist: artist || null,
      fileName: fileName || '',
      title: finalTitle,
      duration: finalDuration,
    },
    { upsert: true, new: true }
  );

  return upload.toPublic();
}

export async function deleteMedia(uploadId: string, userId: string, logger: Record<string, unknown>): Promise<Record<string, unknown>> {
  const upload = await Upload.findById(uploadId);
  if (!upload) return { error: 'Upload not found', status: 404 };
  if (!upload.userId || upload.userId.toString() !== userId) return { error: 'Not authorized', status: 403 };

  if (upload.source === 'cloudinary' && upload.publicId && isCloudinaryConfigured()) {
    try {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
      await cloudinary.uploader.destroy(upload.publicId, { resource_type: 'video' });
      (logger as { info: (o: Record<string, unknown>, s: string) => void }).info({ publicId: upload.publicId }, 'Cloudinary asset deleted');
    } catch (err) {
      (logger as { warn: (o: Record<string, unknown>, s: string) => void }).warn({ err, publicId: upload.publicId }, 'Failed to delete Cloudinary asset');
    }
  }

  await upload.deleteOne();
  return {};
}

export async function updateMedia(uploadId: string, userId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
  const upload = await Upload.findById(uploadId);
  if (!upload) return { error: 'Upload not found', status: 404 };
  if (!upload.userId || upload.userId.toString() !== userId) return { error: 'Not authorized', status: 403 };

  const allowedFields = ['title', 'fileName', 'duration'];
  const updateData: Record<string, unknown> = {};

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      updateData[field] = updates[field];
    }
  }

  if (Object.keys(updateData).length === 0) {
    return { error: 'No valid fields to update', status: 400 };
  }

  const updated = await Upload.findByIdAndUpdate(
    uploadId,
    { $set: updateData },
    { new: true }
  );

  if (!updated) return { error: 'Upload not found after update', status: 404 };
  return updated.toPublic();
}

export async function getMedia(uploadId: string, userId: string): Promise<Record<string, unknown>> {
  const upload = await Upload.findById(uploadId);
  if (!upload) return { error: 'Upload not found', status: 404 };
  if (!upload.userId || upload.userId.toString() !== userId) return { error: 'Not authorized', status: 403 };

  const projects = await Project.find({ uploadId }).select('projectId title updatedAt').lean();

  return {
    ...upload.toPublic(),
    projects: projects.map((p: Record<string, unknown>) => ({
      projectId: p.projectId,
      title: (p as Record<string, string>).title || 'Untitled',
      updatedAt: p.updatedAt,
    })),
  };
}
