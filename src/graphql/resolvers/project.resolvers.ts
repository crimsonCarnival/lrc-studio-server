import Project from '../../modules/projects/project.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import ProjectStar from '../../modules/projects/projectStar.model.js';
import {
  createProject as createProjectService,
  listProjects,
  patchProject,
  deleteProject as deleteProjectService,
  getShareProject,
  cloneProject,
} from '../../modules/projects/projects.service.js';
import { getProject } from '../../modules/projects/projects.crud.service.js';
import { Context } from './context.js';
import User from '../../db/user.model.js';
import { upsertSocial } from '../../modules/notifications/notifications.service.js';
import { emitProjectUpdated } from '../../modules/projects/projects.controller.js';
import { getIO } from '../../socket/socket.manager.js';

export const projectResolvers = {
  Query: {
    // id is the projectId nanoid string, NOT the MongoDB _id
    project: async (_root: any, { id }: { id: string }, context: Context) => {
      return getProject(id, context.userId ?? null);
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
      emitProjectUpdated(id, input);
      // Ack to the saving client
      try {
        if (context.socketId) {
          getIO().to(context.socketId).emit('autosave:ack', { projectId: id, savedAt: Date.now() });
        }
      } catch { /* socket not ready */ }
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

    starProject: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        const err = new Error('Unauthorized') as any;
        err.status = 401;
        throw err;
      }
      const project = await Project.findOne({ projectId: id }).select('userId title').lean();
      if (!project) throw new Error('Project not found');

      try {
        const existing = await ProjectStar.findOneAndUpdate(
          { projectId: id, userId: context.userId },
          { $setOnInsert: { projectId: id, userId: context.userId } },
          { upsert: true, new: false }
        );
        if (!existing) {
          await Project.updateOne({ projectId: id }, { $inc: { starCount: 1 } });
          const ownerId = project.userId?.toString();
          if (ownerId) {
            User.findById(context.userId).select('accountName avatarUrl').lean().then(actor => {
              if (actor) {
                upsertSocial({
                  ownerId,
                  type: 'star',
                  projectId: id,
                  projectTitle: (project as any).title || '',
                  actorId: context.userId!,
                  actorAccountName: (actor as any).accountName,
                  actorAvatarUrl: (actor as any).avatarUrl || null,
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      } catch (err: any) {
        if (err.code !== 11000) throw err;
      }
      return Project.findOne({ projectId: id });
    },

    unstarProject: async (_root: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        const err = new Error('Unauthorized') as any;
        err.status = 401;
        throw err;
      }
      // deleteOne is atomic — only one concurrent request will get deletedCount: 1
      const { deletedCount } = await ProjectStar.deleteOne({ projectId: id, userId: context.userId });
      if (deletedCount > 0) {
        await Project.updateOne(
          { projectId: id, starCount: { $gt: 0 } },
          { $inc: { starCount: -1 } }
        );
      }
      return Project.findOne({ projectId: id });
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
  },
};
