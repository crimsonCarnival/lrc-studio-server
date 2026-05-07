import { MercuriusContext } from 'mercurius';
import User from '../db/user.model.js';
import Project from '../modules/projects/project.model.js';
import Lyrics from '../modules/lyrics/lyrics.model.js';
import Upload from '../modules/uploads/upload.model.js';
import Settings from '../modules/settings/settings.model.js';
import { fetchYouTubeTitle } from '../utils/youtube.js';
import {
  createProject as createProjectService,
  listProjects,
  patchProject,
  deleteProject as deleteProjectService,
} from '../modules/projects/projects.service.js';

interface Context extends MercuriusContext {
  userId?: string | null;
  ip?: string;
}

export const resolvers = {
  Query: {
    health: async () => ({
      status: 'ok',
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
    }),

    me: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) return null;
      const user = await User.findById(context.userId);
      return user?.toPublic();
    },

    // id is the projectId nanoid string, NOT the MongoDB _id
    project: async (_root: any, { id }: { id: string }) => {
      return Project.findOne({ projectId: id });
    },

    projects: async (_root: any, { limit = 20, offset = 0 }: { limit?: number; offset?: number }, context: Context) => {
      if (!context.userId) return [];
      // Use the service which includes line counts and proper mapping
      return listProjects(context.userId);
    },

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

    settings: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) return null;
      return Settings.findOne({ userId: context.userId });
    },
  },

  Mutation: {
    // Delegates to the full service: verifies reCAPTCHA, creates Lyrics doc, links lyricsId
    createProject: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await createProjectService(input, context.userId, context.ip || '');
      if ('error' in result) throw new Error((result as any).error);
      return Project.findOne({ projectId: (result as any).projectId });
    },

    // id = projectId (nanoid string). Delegates to patchProject service for version locking,
    // single-line atomic updates, and lyrics patching.
    updateProject: async (_root: any, { id, input }: { id: string; input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await patchProject(id, input, context.userId);
      if ('error' in result) {
        const err = result as any;
        const statusErr = new Error(err.error) as any;
        statusErr.status = err.status;
        throw statusErr;
      }
      return Project.findOne({ projectId: id });
    },

    // id = projectId (nanoid string)
    deleteProject: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await deleteProjectService(id, context.userId);
      return !('error' in result);
    },

    updateLyrics: async (_root: any, { projectId, input }: { projectId: string; input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const project = await Project.findOne({ projectId, userId: context.userId });
      if (!project) throw new Error('Project not found or access denied');
      return Lyrics.findOneAndUpdate(
        { projectId },
        { $set: input },
        { new: true, upsert: true }
      );
    },

    updateProfile: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const user = await User.findByIdAndUpdate(context.userId, { $set: input }, { new: true });
      return user?.toPublic();
    },

    updateSettings: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      return Settings.findOneAndUpdate(
        { userId: context.userId },
        { $set: input },
        { new: true, upsert: true }
      );
    },

    resetSettings: async (_root: any, _args: any, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      await Settings.deleteOne({ userId: context.userId });
      return true;
    },

    // Uses upsert to deduplicate by source+URL, matching the REST service behavior
    saveMedia: async (_root: any, { input }: { input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const { source, youtubeUrl, cloudinaryUrl, spotifyTrackId } = input;

      // Auto-resolve or refresh the title from the YouTube API
      let resolvedTitle = input.title || '';
      const isGeneric = !resolvedTitle || ['Sin título', 'Untitled', '無題', 'test'].includes(resolvedTitle);
      
      if (source === 'youtube' && youtubeUrl && isGeneric) {
        const fetched = await fetchYouTubeTitle(youtubeUrl);
        if (fetched) resolvedTitle = fetched;
      }

      const query: Record<string, any> = { userId: context.userId, source };
      if (source === 'youtube' && youtubeUrl) query.youtubeUrl = youtubeUrl;
      else if (source === 'cloudinary' && cloudinaryUrl) query.cloudinaryUrl = cloudinaryUrl;
      else if (source === 'spotify' && spotifyTrackId) query.spotifyTrackId = spotifyTrackId;

      return Upload.findOneAndUpdate(
        query,
        { ...input, title: resolvedTitle, userId: context.userId },
        { upsert: true, new: true }
      );
    },

    deleteMedia: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await Upload.deleteOne({ _id: id, userId: context.userId });
      return result.deletedCount === 1;
    },
  },

  // ── Field Resolvers ────────────────────────────────────────────────────────
  // These receive raw Mongoose documents. Loaders in loaders.ts will batch
  // the user/upload/lyrics lookups to avoid N+1 queries.

  Project: {
    // Map Mongoose _id to GraphQL id
    id: (project: any) => project._id?.toString() || project.id || null,
    createdAt: (project: any) => project.createdAt ? new Date(project.createdAt).toISOString() : null,
    updatedAt: (project: any) => project.updatedAt ? new Date(project.updatedAt).toISOString() : null,
    // lyrics is fetched by projectId (more reliable than lyricsId in plain objects)
    lyrics: async (project: any) => {
      if (project.projectId) return Lyrics.findOne({ projectId: project.projectId });
      if (project.lyricsId) return Lyrics.findById(project.lyricsId);
      return null;
    },
    // Ensure upload is populated if queried
    upload: async (project: any) => {
      if (project.uploadId) return Upload.findById(project.uploadId);
      return null;
    },
    lineCount: async (project: any) => {
      const lyrics = await Lyrics.findOne({ projectId: project.projectId });
      return lyrics?.lines?.length ?? 0;
    },
    syncedLineCount: async (project: any) => {
      const lyrics = await Lyrics.findOne({ projectId: project.projectId });
      if (!lyrics?.lines) return 0;
      return lyrics.lines.filter((l: any) => l.timestamp !== null && l.timestamp !== undefined).length;
    }
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

  Lyrics: {
    id: (lyrics: any) => lyrics._id?.toString() ?? lyrics.id,
    createdAt: (lyrics: any) => lyrics.createdAt ? new Date(lyrics.createdAt).toISOString() : null,
    updatedAt: (lyrics: any) => lyrics.updatedAt ? new Date(lyrics.updatedAt).toISOString() : null,
  },

  User: {
    id: (user: any) => user._id?.toString() ?? user.id,
    createdAt: (user: any) => user.createdAt ? new Date(user.createdAt).toISOString() : null,
    projects: async (user: any) => Project.find({ userId: user._id ?? user.id }),
    uploads: async (user: any) => Upload.find({ userId: user._id ?? user.id }),
    settings: async (user: any) => Settings.findOne({ userId: user._id ?? user.id }),
  },
};
