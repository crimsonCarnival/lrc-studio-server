import Upload from '../../modules/uploads/upload.model.js';
import Project from '../../modules/projects/project.model.js';
import { fetchYouTubeTitle } from '../../utils/youtube.js';
import { Context } from './context.js';
import { triggerBadgeCheck } from '../../modules/badges/badge.service.js';

export interface SaveMediaInput {
  source: string;
  uploadUrl?: string;
  title?: string;
  [key: string]: unknown;
}

export interface UploadDoc {
  _id?: { toString(): string };
  id?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export const uploadResolvers = {
  Query: {
    upload: async (_root: unknown, { id }: { id: string }, context: Context) => {
      const upload = await Upload.findById(id);
      if (!upload) return null;
      // Ownerless (guest, userId: null) uploads are denied too, not just
      // mismatched-owner ones — mirrors the REST twin (uploads.service.ts
      // getMedia). Guests never reach this query in practice: the `uploads`
      // list query above already returns [] when unauthenticated, so there's
      // nothing to click into. Unrelated to Project.upload (project.resolvers.ts),
      // which stays ungated since access there is already decided by the
      // project query itself (public/shared projects must still resolve media).
      if (!upload.userId || upload.userId.toString() !== context.userId) return null;
      return upload;
    },

    uploads: async (_root: unknown, { limit = 50, offset = 0 }: { limit?: number; offset?: number }, context: Context) => {
      if (!context.userId) return [];
      return Upload.find({ userId: context.userId })
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit);
    },
  },

  Mutation: {
    // Uses upsert to deduplicate by source+URL, matching the REST service behavior
    saveMedia: async (_root: unknown, { input }: { input: SaveMediaInput }, context: Context) => {
      const { source, uploadUrl } = input;

      // Auto-resolve or refresh the title from the YouTube API
      let resolvedTitle = input.title || '';
      const isGeneric = !resolvedTitle || ['Sin título', 'Untitled', '無題', 'test'].includes(resolvedTitle);

      if (source === 'youtube' && uploadUrl && isGeneric) {
        const fetched = await fetchYouTubeTitle(uploadUrl);
        if (fetched) resolvedTitle = fetched;
      }

      const query: Record<string, unknown> = { userId: context.userId || null, source };
      if (source === 'youtube' && uploadUrl) query.uploadUrl = uploadUrl;
      else if (source === 'cloudinary' && uploadUrl) query.uploadUrl = uploadUrl;

      const upload = await Upload.findOneAndUpdate(
        query,
        { ...input, title: resolvedTitle, userId: context.userId || null },
        { upsert: true, new: true }
      );
      if (context.userId) triggerBadgeCheck(context.userId, 'upload_create').catch(() => {});
      return upload;
    },

    deleteMedia: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await Upload.deleteOne({ _id: id, userId: context.userId });
      return result.deletedCount === 1;
    },
  },

  Upload: {
    id: (upload: UploadDoc) => upload._id?.toString() || upload.id || null,
    createdAt: (upload: UploadDoc) => upload.createdAt ? new Date(upload.createdAt).toISOString() : null,
    updatedAt: (upload: UploadDoc) => upload.updatedAt ? new Date(upload.updatedAt).toISOString() : null,
    projects: async (upload: UploadDoc) => {
      const uploadId = upload._id ?? upload.id;
      if (!uploadId) return [];
      return Project.find({ uploadId }).sort({ updatedAt: -1 });
    }
  },
};
