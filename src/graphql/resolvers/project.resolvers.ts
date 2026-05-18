import { MercuriusContext } from 'mercurius';
import Project from '../../modules/projects/project.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import {
  createProject as createProjectService,
  listProjects,
  patchProject,
  deleteProject as deleteProjectService,
  getShareProject,
  cloneProject,
} from '../../modules/projects/projects.service.js';

interface Context extends MercuriusContext {
  userId?: string | null;
  ip?: string;
  tokenExpired?: boolean;
}

export const projectResolvers = {
  Query: {
    // id is the projectId nanoid string, NOT the MongoDB _id
    project: async (_root: any, { id }: { id: string }) => {
      return Project.findOne({ projectId: id });
    },

    projects: async (_root: any, { limit = 20, offset = 0 }: { limit?: number; offset?: number }, context: Context) => {
      if (!context.userId) return [];
      // Use the service which includes line counts and proper mapping
      return listProjects(context.userId);
    },

    getShare: async (_root: any, { id }: { id: string }) => {
      return getShareProject(id);
    },
  },

  Mutation: {
    // Delegates to the full service: verifies reCAPTCHA, creates Lyrics doc, links lyricsId
    createProject: async (_root: any, { input }: { input: any }, context: Context) => {
      const result = await createProjectService(input, context.userId, context.ip || '');
      if ('error' in result) throw new Error((result as any).error);
      return Project.findOne({ projectId: (result as any).projectId });
    },

    // id = projectId (nanoid string). Delegates to patchProject service for version locking,
    // single-line atomic updates, and lyrics patching.
    updateProject: async (_root: any, { id, input }: { id: string; input: any }, context: Context) => {
      // If a Bearer token was sent but was expired, surface a 401 so the client
      // can refresh — otherwise optionalAuth would silently drop the userId and
      // the ownership check would produce a confusing 403.
      if (context.tokenExpired) {
        const expiredErr = new Error('Token expired') as any;
        expiredErr.status = 401;
        throw expiredErr;
      }
      const result = await patchProject(id, input, context.userId);
      if ('error' in result) {
        const err = result as any;
        const statusErr = new Error(err.error) as any;
        statusErr.status = err.status;
        throw statusErr;
      }
      return (result as any).project;
    },

    // id = projectId (nanoid string)
    deleteProject: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await deleteProjectService(id, context.userId);
      return !('error' in result);
    },

    cloneProject: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await cloneProject(id, context.userId);
      if ('error' in result) throw new Error((result as any).error);
      return Project.findOne({ projectId: (result as any).projectId });
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
      if (project.lyrics) return project.lyrics;
      if (project.projectId) return Lyrics.findOne({ projectId: project.projectId });
      if (project.lyricsId) return Lyrics.findById(project.lyricsId);
      return null;
    },
    // Ensure upload is populated if queried
    upload: async (project: any) => {
      if (project.upload) return project.upload;
      if (project.uploadId) return Upload.findById(project.uploadId);
      return null;
    },
    lineCount: async (project: any) => {
      if (project.lineCount !== undefined) return project.lineCount;
      const lyrics = await Lyrics.findOne({ projectId: project.projectId }).select('lines');
      return lyrics?.lines?.length ?? 0;
    },
    syncedLineCount: async (project: any) => {
      if (project.syncedLineCount !== undefined) return project.syncedLineCount;
      const lyrics = await Lyrics.findOne({ projectId: project.projectId }).select('lines');
      if (!lyrics?.lines) return 0;
      return lyrics.lines.filter((l: any) => l.timestamp !== null && l.timestamp !== undefined).length;
    }
  },
};
