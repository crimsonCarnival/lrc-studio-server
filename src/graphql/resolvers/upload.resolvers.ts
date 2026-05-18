import { MercuriusContext } from 'mercurius';
import Upload from '../../modules/uploads/upload.model.js';
import Project from '../../modules/projects/project.model.js';
import { fetchYouTubeTitle } from '../../utils/youtube.js';

interface Context extends MercuriusContext {
  userId?: string | null;
  ip?: string;
  tokenExpired?: boolean;
}

export const uploadResolvers = {
  Query: {
    upload: async (_root: any, { id }: { id: string }) => {
      return Upload.findById(id);
    },

    uploads: async (_root: any, { limit = 50, offset = 0 }: { limit?: number; offset?: number }, context: Context) => {
      if (!context.userId) return [];
      return Upload.find({ userId: context.userId })
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit);
    },
  },

  Mutation: {
    // Uses upsert to deduplicate by source+URL, matching the REST service behavior
    saveMedia: async (_root: any, { input }: { input: any }, context: Context) => {
      // Spotify always requires auth. Cloudinary and YouTube are open to guests.
      if (!context.userId && input.source === 'spotify') throw new Error('Unauthorized');
      const { source, youtubeUrl, cloudinaryUrl, spotifyTrackId } = input;

      // Auto-resolve or refresh the title from the YouTube API
      let resolvedTitle = input.title || '';
      const isGeneric = !resolvedTitle || ['Sin título', 'Untitled', '無題', 'test'].includes(resolvedTitle);

      if (source === 'youtube' && youtubeUrl && isGeneric) {
        const fetched = await fetchYouTubeTitle(youtubeUrl);
        if (fetched) resolvedTitle = fetched;
      }

      const query: Record<string, any> = { userId: context.userId || null, source };
      if (source === 'youtube' && youtubeUrl) query.youtubeUrl = youtubeUrl;
      else if (source === 'cloudinary' && cloudinaryUrl) query.cloudinaryUrl = cloudinaryUrl;
      else if (source === 'spotify' && spotifyTrackId) query.spotifyTrackId = spotifyTrackId;

      return Upload.findOneAndUpdate(
        query,
        { ...input, title: resolvedTitle, userId: context.userId || null },
        { upsert: true, new: true }
      );
    },

    deleteMedia: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await Upload.deleteOne({ _id: id, userId: context.userId });
      return result.deletedCount === 1;
    },
  },

  Upload: {
    id: (upload: any) => upload._id?.toString() || upload.id || null,
    createdAt: (upload: any) => upload.createdAt ? new Date(upload.createdAt).toISOString() : null,
    updatedAt: (upload: any) => upload.updatedAt ? new Date(upload.updatedAt).toISOString() : null,
    projects: async (upload: any) => {
      const uploadId = upload._id ?? upload.id;
      if (!uploadId) return [];
      return Project.find({ uploadId }).sort({ updatedAt: -1 });
    }
  },
};
