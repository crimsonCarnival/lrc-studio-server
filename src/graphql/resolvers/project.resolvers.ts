import mongoose from 'mongoose';
import Project from '../../modules/projects/project.model.js';
import type { IProject } from '../../modules/projects/project.model.js';
import Boost from '../../db/boost.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import Upload from '../../modules/uploads/upload.model.js';
import ProjectStar from '../../modules/projects/projectStar.model.js';
import ProjectFork from '../../modules/projects/projectFork.model.js';
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
import type { IUser } from '../../db/user.model.js';
import { upsertSocial } from '../../modules/notifications/notifications.service.js';
import { emitProjectUpdated } from '../../modules/projects/projects.controller.js';
import { getIO } from '../../socket/socket.manager.js';
import { writeActivity } from '../../modules/activity/activity.service.js';
import { searchProjects as searchProjectsService } from '../../modules/projects/projects.search.service.js';
import { getBlockedSet } from '../../modules/blocks/block.service.js';
import type { SearchSort } from '../../modules/projects/projects.search.service.js';
import { triggerBadgeCheck, updateStreak } from '../../modules/badges/badge.service.js';
import { upsertMusicLibraryEntry } from '../../modules/users/music-library.service.js';

export const projectResolvers = {
  Query: {
    // id is the publicId nanoid string, NOT the MongoDB _id
    project: async (_root: unknown, { id }: { id: string }, context: Context) => {
      return getProject(id, context.userId ?? null);
    },

    projects: async (_root: unknown, { limit: _limit = 20, offset: _offset = 0 }: { limit?: number; offset?: number }, context: Context) => {
      if (!context.userId) return [];
      // Use the service which includes line counts and proper mapping
      return listProjects(context.userId);
    },

    myMusicLibrary: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) return [];
      const rows = await Project.find(
        { userId: context.userId, isDeleted: { $ne: true } },
        { 'metadata.songArtist': 1, 'metadata.songAlbum': 1, 'metadata.genre': 1, 'metadata.songLanguage': 1, 'metadata.trackCount': 1 }
      ).lean<IProject[]>();
      const seen = new Set<string>();
      const results: { artist: string; album: string; genre: string; language: string; trackCount: number | null }[] = [];
      for (const row of rows) {
        const m = (row.metadata ?? {}) as Record<string, unknown>;
        const artist = (m['songArtist'] as string) || '';
        const album = (m['songAlbum'] as string) || '';
        if (!artist && !album) continue;
        const key = `${artist}||${album}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ artist, album, genre: (m['genre'] as string) || '', language: (m['songLanguage'] as string) || '', trackCount: (m['trackCount'] as number | null) ?? null });
      }
      return results;
    },

    getShare: async (_root: unknown, { id }: { id: string }) => {
      return getShareProject(id);
    },

    publicProject: async (_root: unknown, { publicId }: { publicId: string }) => {
      const project = await Project.findOne({ publicId, public: true }).lean();
      return project ?? null;
    },

    searchProjects: async (
      _root: unknown,
      { query, sortBy = 'RELEVANCE', offset = 0, limit = 20 }:
        { query: string; sortBy?: string; offset?: number; limit?: number },
      context: Context
    ) => {
      if (!query.trim()) return { projects: [], total: 0 };
      const result = await searchProjectsService(query, sortBy as SearchSort, offset, Math.min(limit, 50));
      if (!context.userId) return result;
      const blockedSet = await getBlockedSet(context.userId);
      if (blockedSet.size === 0) return result;
      const projects = (result.projects as { userId?: { toString(): string } }[])
        .filter((p) => !p.userId || !blockedSet.has(p.userId.toString()));
      return { ...result, projects };
    },
  },

  Mutation: {
    // Delegates to the full service: verifies reCAPTCHA, creates Lyrics doc, links lyricsId
    createProject: async (_root: unknown, { input }: { input: Record<string, unknown> }, context: Context) => {
      const result = await createProjectService(input, context.userId, context.ip || '');
      if ('error' in result) throw new Error(result.error ?? 'Unknown error');
      const created = result as { publicId: string; url: string };
      if (context.userId) {
        const meta = input.metadata as {
          songArtist?: string;
          songAlbum?: string;
          songGenre?: string;
          songLanguage?: string;
          trackCount?: number | null;
        } | undefined;
        Promise.all([
          updateStreak(context.userId),
          triggerBadgeCheck(context.userId, 'project_create'),
          ...(input.public ? [triggerBadgeCheck(context.userId, 'project_publish')] : []),
          ...(meta?.songArtist || meta?.songAlbum
            ? [upsertMusicLibraryEntry(context.userId, { artist: meta.songArtist || '', album: meta.songAlbum || '', genre: meta.songGenre, language: meta.songLanguage, trackCount: meta.trackCount })]
            : []),
        ]).catch(() => {});
      }
      return Project.findOne({ publicId: created.publicId });
    },

    // id = publicId (nanoid string). Delegates to patchProject service for version locking,
    // single-line atomic updates, and lyrics patching.
    updateProject: async (_root: unknown, { id, input }: { id: string; input: Record<string, unknown> }, context: Context) => {
      // If a Bearer token was sent but was expired, surface a 401 so the client
      // can refresh — otherwise optionalAuth would silently drop the userId and
      // the ownership check would produce a confusing 403.
      if (context.tokenExpired) {
        const expiredErr = new Error('Token expired') as Error & { status: number };
        expiredErr.status = 401;
        throw expiredErr;
      }
      const result = await patchProject(id, input, context.userId);
      if ('error' in result) {
        const statusErr = new Error(result.error ?? 'Unknown error') as Error & { status?: number };
        statusErr.status = result.status;
        throw statusErr;
      }
      const patched = result as { project: unknown };
      emitProjectUpdated(id, input);
      try {
        if (context.socketId) {
          getIO().to(context.socketId).emit('autosave:ack', { publicId: id, savedAt: Date.now() });
        }
      } catch { /* socket not ready */ }
      // If project is being published for the first time, check public_project_count badge
      if (context.userId && input.public === true) {
        triggerBadgeCheck(context.userId, 'project_publish').catch(() => {});
      }
      if (context.userId && input.metadata) {
        const meta = input.metadata as {
          songArtist?: string;
          songAlbum?: string;
          songGenre?: string;
          songLanguage?: string;
          trackCount?: number | null;
        };
        if (meta.songArtist || meta.songAlbum) {
          upsertMusicLibraryEntry(context.userId, { artist: meta.songArtist || '', album: meta.songAlbum || '', genre: meta.songGenre, language: meta.songLanguage, trackCount: meta.trackCount }).catch(() => {});
        }
      }
      return patched.project;
    },

    // id = publicId (nanoid string)
    deleteProject: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const result = await deleteProjectService(id, context.userId);
      return !('error' in result);
    },

    cloneProject: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');

      const alreadyForked = await ProjectFork.exists({ sourcepublicId: id, userId: context.userId });
      if (alreadyForked) throw new Error('already_forked');

      // Fetch source metadata before cloning — needed for the activity payload
      const sourceProject = await Project.findOne({ publicId: id })
        .select('title coverImage userId')
        .lean<IProject>();

      const result = await cloneProject(id, context.userId);
      if ('error' in result) throw new Error(result.error ?? 'Unknown error');
      const cloned = result as { publicId: string; url: string };

      writeActivity({
        actorId:      context.userId,
        type:         'project_forked',
        publicId:    id,
        projectTitle: sourceProject?.title || '',
        coverImage:   sourceProject?.coverImage || '',
      }).catch(() => {});

      // Badge: fork_received for source project owner
      const sourceOwnerId = sourceProject?.userId?.toString();
      if (sourceOwnerId && sourceOwnerId !== context.userId) {
        User.updateOne({ _id: sourceOwnerId }, { $inc: { 'social.totalForksReceived': 1 } })
          .then(() => triggerBadgeCheck(sourceOwnerId, 'fork_received'))
          .catch(() => {});
      }
      // Badge: project_create for the forker
      Promise.all([updateStreak(context.userId), triggerBadgeCheck(context.userId, 'project_create')]).catch(() => {});

      return Project.findOne({ publicId: cloned.publicId });
    },

    starProject: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        const err = new Error('Unauthorized') as Error & { status: number };
        err.status = 401;
        throw err;
      }
      const project = await Project.findOne({ publicId: id }).select('userId title coverImage').lean<IProject>();
      if (!project) throw new Error('Project not found');

      let isNewStar = false;
      try {
        const existing = await ProjectStar.findOneAndUpdate(
          { publicId: id, userId: context.userId },
          { $setOnInsert: { publicId: id, userId: context.userId } },
          { upsert: true, new: false }
        );
        if (!existing) {
          isNewStar = true;
          await Project.updateOne({ publicId: id }, { $inc: { starCount: 1 } });
          const ownerId = project.userId?.toString();
          if (ownerId) {
            User.findById(context.userId).select('accountName avatarUrl').lean<IUser>().then(actor => {
              if (actor) {
                upsertSocial({
                  ownerId,
                  type: 'star',
                  publicId: id,
                  projectTitle: project.title || '',
                  actorId: context.userId!,
                  actorAccountName: actor.accountName ?? '',
                  actorAvatarUrl: actor.avatarUrl || null,
                }).catch(() => {});
              }
            }).catch(() => {});
            // Increment denormalized star count on owner, then check badges
            User.updateOne({ _id: ownerId }, { $inc: { 'social.totalStarsReceived': 1 } })
              .then(() => triggerBadgeCheck(ownerId, 'star_received'))
              .catch(() => {});
          }
        }
      } catch (err: unknown) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
      // writeActivity is outside the upsert try/catch so a duplicate-key swallow
      // doesn't silently suppress the activity error path
      if (isNewStar) {
        writeActivity({
          actorId:      context.userId!,
          type:         'project_starred',
          publicId:    id,
          projectTitle: project.title || '',
          coverImage:   project.coverImage || '',
        }).catch(() => {});
      }
      return Project.findOne({ publicId: id });
    },

    unstarProject: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        const err = new Error('Unauthorized') as Error & { status: number };
        err.status = 401;
        throw err;
      }
      // deleteOne is atomic — only one concurrent request will get deletedCount: 1
      const { deletedCount } = await ProjectStar.deleteOne({ publicId: id, userId: context.userId });
      if (deletedCount > 0) {
        await Project.updateOne(
          { publicId: id, starCount: { $gt: 0 } },
          { $inc: { starCount: -1 } }
        );
      }
      return Project.findOne({ publicId: id });
    },

    setForksEnabled: async (_root: unknown, { publicId, enabled }: { publicId: string; enabled: boolean }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const project = await Project.findOne({ publicId, userId: context.userId });
      if (!project) throw new Error('Project not found or not yours');
      project.forksEnabled = enabled;
      await project.save();
      return project;
    },

    boostProject: async (_: unknown, { publicId }: { publicId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthorized');

      const project = await Project.findOne({ publicId, public: true }).lean<IProject>();
      if (!project) throw new Error('Project not found');
      if (project.userId?.toString() === ctx.userId) throw new Error('Cannot boost your own project');

      try {
        await Boost.create({ userId: new mongoose.Types.ObjectId(ctx.userId), publicId });
      } catch (err: unknown) {
        if ((err as { code?: number }).code === 11000) return true;
        throw err;
      }

      const actor = await User.findById(ctx.userId).select('accountName').lean<IUser>();
      if (actor) {
        writeActivity({
          actorId: ctx.userId,
          type: 'project_boosted',
          publicId,
          projectTitle: project.title || (project.metadata as Record<string, unknown> | undefined)?.['songName'] as string || '',
          coverImage: project.coverImage ?? '',
          targetPath: '',
        }).catch(() => {});
      }

      return true;
    },
  },

  // ── Field Resolvers ────────────────────────────────────────────────────────
  // These receive raw Mongoose documents. Loaders in loaders.ts will batch
  // the user/upload/lyrics lookups to avoid N+1 queries.

  Project: {
    id: (project: IProject) => project._id?.toString() || project.id || null,
    createdAt: (project: IProject) => project.createdAt ? new Date(project.createdAt).toISOString() : null,
    updatedAt: (project: IProject) => project.updatedAt ? new Date(project.updatedAt).toISOString() : null,
    isStarredByMe: async (project: IProject, _args: Record<string, unknown>, ctx: Context) => {
      if (!ctx.userId || !project.publicId) return false;
      return !!(await ProjectStar.exists({ publicId: project.publicId, userId: ctx.userId }));
    },
    isForkedByMe: async (project: IProject, _args: Record<string, unknown>, ctx: Context) => {
      if (!ctx.userId || !project.publicId) return false;
      return !!(await ProjectFork.exists({ sourcepublicId: project.publicId, userId: ctx.userId }));
    },
    // lyrics is fetched by publicId (more reliable than lyricsId in plain objects)
    lyrics: async (project: IProject) => {
      if ((project as IProject & { lyrics?: unknown }).lyrics) return (project as IProject & { lyrics?: unknown }).lyrics;
      if (project.publicId) return Lyrics.findOne({ publicId: project.publicId });
      if (project.lyricsId) return Lyrics.findById(project.lyricsId);
      return null;
    },
    // Ensure upload is populated if queried
    upload: async (project: IProject) => {
      if ((project as IProject & { upload?: unknown }).upload) return (project as IProject & { upload?: unknown }).upload;
      if (project.uploadId) return Upload.findById(project.uploadId);
      return null;
    },
  },
};
