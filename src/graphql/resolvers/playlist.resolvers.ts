import mongoose from 'mongoose';
import Playlist from '../../db/playlist.model.js';
import type { IPlaylist } from '../../db/playlist.model.js';
import SavedPlaylist from '../../db/saved-playlist.model.js';
import Project from '../../modules/projects/project.model.js';
import type { IProject } from '../../modules/projects/project.model.js';
import User from '../../db/user.model.js';
import type { IUser } from '../../db/user.model.js';
import { Context } from './context.js';
import { writeActivity } from '../../modules/activity/activity.service.js';

type LeanPlaylist = IPlaylist & { _id: mongoose.Types.ObjectId };
type LeanUser = IUser & { _id: mongoose.Types.ObjectId };

export interface PlaylistInput {
  name?: string;
  description?: string | null;
  coverImage?: string;
  tags?: string[];
  isPublic?: boolean;
  sortMode?: string;
  projectIds?: string[];
}

async function resolveProjects(playlist: LeanPlaylist) {
  if (!playlist.projectIds?.length) return [];
  const docs = await Project.find({ _id: { $in: playlist.projectIds } }).lean<IProject[]>();
  const mode = playlist.sortMode;
  if (mode === 'STARS') {
    return docs.sort((a, b) => (b.starCount ?? 0) - (a.starCount ?? 0));
  }
  if (mode === 'ALPHABETICAL') {
    return docs.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }
  // MANUAL and DATE_ADDED: preserve projectIds insertion order, filter missing
  type LeanProject = IProject & { _id: mongoose.Types.ObjectId };
  const map = new Map((docs as LeanProject[]).map(d => [d._id.toString(), d]));
  return playlist.projectIds.map(id => map.get(id.toString())).filter(Boolean);
}

async function formatPlaylist(playlist: LeanPlaylist, context: Context) {
  const [projects, owner, isSavedByMe] = await Promise.all([
    resolveProjects(playlist),
    User.findById(playlist.userId).lean<LeanUser>(),
    context.userId
      ? SavedPlaylist.exists({ userId: context.userId, playlistId: playlist._id })
      : Promise.resolve(false),
  ]);

  return {
    id: playlist._id.toString(),
    owner: owner
      ? {
          id: owner._id.toString(),
          accountName: owner.accountName,
          displayName: owner.displayName ?? null,
          avatarUrl: owner.avatarUrl ?? null,
        }
      : null,
    name: playlist.name,
    description: playlist.description ?? null,
    coverImage: playlist.coverImage ?? null,
    tags: playlist.tags ?? [],
    isPublic: playlist.isPublic,
    sortMode: playlist.sortMode,
    projects,
    projectCount: playlist.projectIds?.length ?? 0,
    savedCount: playlist.savedCount ?? 0,
    isSavedByMe: !!isSavedByMe,
    createdAt: new Date(playlist.createdAt).toISOString(),
    updatedAt: new Date(playlist.updatedAt).toISOString(),
  };
}

function validatePlaylistInput(input: PlaylistInput) {
  if (input.name !== undefined && input.name.trim().length === 0) throw new Error('validation_error');
  if (input.name !== undefined && input.name.length > 100) throw new Error('validation_error');
  if (input.description !== undefined && input.description !== null && input.description.length > 500) throw new Error('validation_error');
  if (input.tags !== undefined) {
    if (input.tags.length > 10) throw new Error('validation_error');
    if (input.tags.some((t: string) => t.length > 30)) throw new Error('validation_error');
  }
}

export const playlistResolvers = {
  Query: {
    playlist: async (_root: unknown, { id }: { id: string }, context: Context) => {
      const playlist = await Playlist.findById(id).lean<LeanPlaylist>();
      if (!playlist) throw new Error('not_found');
      if (!playlist.isPublic && context.userId !== playlist.userId.toString()) {
        throw new Error('forbidden');
      }
      return formatPlaylist(playlist, context);
    },

    playlists: async (_root: unknown, { accountName }: { accountName: string }, context: Context) => {
      const user = await User.findOne({ accountName: accountName.toLowerCase() }).lean<LeanUser>();
      if (!user || user.isDeleted || user.ban?.active) return [];
      const isOwner = context.userId && context.userId === user._id.toString();
      const filter: { userId: mongoose.Types.ObjectId; isPublic?: boolean } = { userId: user._id };
      if (!isOwner) filter.isPublic = true;
      const playlists = await Playlist.find(filter).sort({ createdAt: -1 }).limit(100).lean<LeanPlaylist[]>();
      return Promise.all(playlists.map(p => formatPlaylist(p, context)));
    },

    savedPlaylists: async (_root: unknown, _args: Record<string, unknown>, context: Context) => {
      if (!context.userId) throw new Error('unauthorized');
      const saved = await SavedPlaylist.find({ userId: context.userId }).lean();
      if (!saved.length) return [];
      const playlistIds = saved.map(s => s.playlistId);
      const playlists = await Playlist.find({ _id: { $in: playlistIds }, isPublic: true }).lean<LeanPlaylist[]>();
      return Promise.all(playlists.map(p => formatPlaylist(p, context)));
    },
  },

  Mutation: {
    createPlaylist: async (_root: unknown, { input }: { input: PlaylistInput }, context: Context) => {
      if (!context.userId) throw new Error('unauthorized');
      validatePlaylistInput(input);
      if (input.projectIds?.length) {
        const count = await Project.countDocuments({
          _id: { $in: input.projectIds.map((id: string) => new mongoose.Types.ObjectId(id)) },
          userId: new mongoose.Types.ObjectId(context.userId),
        });
        if (count !== input.projectIds.length) throw new Error('forbidden');
      }
      const playlist = await Playlist.create({
        userId: context.userId,
        name: input.name,
        description: input.description,
        coverImage: input.coverImage,
        tags: input.tags ?? [],
        isPublic: input.isPublic ?? true,
        sortMode: input.sortMode ?? 'DATE_ADDED',
        projectIds: (input.projectIds ?? []).map((id: string) => new mongoose.Types.ObjectId(id)),
        savedCount: 0,
      });

      const playlistObj = playlist.toObject() as LeanPlaylist;

      if (playlist.isPublic) {
        const creator = await User.findById(context.userId).select('accountName').lean<LeanUser>();
        if (creator) {
          writeActivity({
            actorId: context.userId,
            type: 'playlist_created',
            projectId: playlistObj._id.toString(),
            projectTitle: playlist.name,
            coverImage: playlistObj.coverImage ?? '',
            targetPath: `/${creator.accountName}/lists/${playlistObj._id}`,
          }).catch(() => {});
        }
      }

      return formatPlaylist(playlistObj, context);
    },

    updatePlaylist: async (_root: unknown, { id, input }: { id: string; input: PlaylistInput }, context: Context) => {
      if (!context.userId) throw new Error('unauthorized');
      validatePlaylistInput(input);
      const playlist = await Playlist.findById(id);
      if (!playlist) throw new Error('not_found');
      if (playlist.userId.toString() !== context.userId) throw new Error('forbidden');
      if (input.name !== undefined) playlist.name = input.name;
      if (input.description !== undefined) playlist.description = input.description ?? undefined;
      if (input.coverImage !== undefined) playlist.coverImage = input.coverImage;
      if (input.tags !== undefined) playlist.tags = input.tags;
      if (input.isPublic !== undefined) playlist.isPublic = input.isPublic;
      if (input.sortMode !== undefined) playlist.sortMode = input.sortMode as IPlaylist['sortMode'];
      await playlist.save();
      return formatPlaylist(playlist.toObject() as LeanPlaylist, context);
    },

    deletePlaylist: async (_root: unknown, { id }: { id: string }, context: Context) => {
      if (!context.userId) throw new Error('unauthorized');
      const playlist = await Playlist.findById(id);
      if (!playlist) throw new Error('not_found');
      if (playlist.userId.toString() !== context.userId) throw new Error('forbidden');
      await SavedPlaylist.deleteMany({ playlistId: new mongoose.Types.ObjectId(id) });
      await Playlist.deleteOne({ _id: id });
      return true;
    },

    addProjectToPlaylist: async (
      _root: unknown,
      { playlistId, projectId }: { playlistId: string; projectId: string },
      context: Context
    ) => {
      if (!context.userId) throw new Error('unauthorized');
      const playlist = await Playlist.findById(playlistId);
      if (!playlist) throw new Error('not_found');
      if (playlist.userId.toString() !== context.userId) throw new Error('forbidden');
      type LeanProject = IProject & { _id: mongoose.Types.ObjectId };
      const project = await Project.findById(projectId).lean<LeanProject>();
      if (!project || project.userId?.toString() !== context.userId) throw new Error('forbidden');
      const updated = await Playlist.findByIdAndUpdate(
        playlistId,
        { $addToSet: { projectIds: new mongoose.Types.ObjectId(projectId) } },
        { new: true }
      ).lean<LeanPlaylist>();
      if (!updated) throw new Error('not_found');
      return formatPlaylist(updated, context);
    },

    removeProjectFromPlaylist: async (
      _root: unknown,
      { playlistId, projectId }: { playlistId: string; projectId: string },
      context: Context
    ) => {
      if (!context.userId) throw new Error('unauthorized');
      const playlist = await Playlist.findById(playlistId);
      if (!playlist) throw new Error('not_found');
      if (playlist.userId.toString() !== context.userId) throw new Error('forbidden');
      const updated = await Playlist.findByIdAndUpdate(
        playlistId,
        { $pull: { projectIds: new mongoose.Types.ObjectId(projectId) } },
        { new: true }
      ).lean<LeanPlaylist>();
      if (!updated) throw new Error('not_found');
      return formatPlaylist(updated, context);
    },

    reorderPlaylist: async (
      _root: unknown,
      { playlistId, projectIds }: { playlistId: string; projectIds: string[] },
      context: Context
    ) => {
      if (!context.userId) throw new Error('unauthorized');
      const playlist = await Playlist.findById(playlistId);
      if (!playlist) throw new Error('not_found');
      if (playlist.userId.toString() !== context.userId) throw new Error('forbidden');
      if (playlist.sortMode !== 'MANUAL') throw new Error('bad_request');
      if (projectIds.length !== playlist.projectIds.length) throw new Error('bad_request');
      const currentSet = new Set(playlist.projectIds.map(id => id.toString()));
      const submittedSet = new Set(projectIds);
      const setsMatch =
        currentSet.size === submittedSet.size && [...currentSet].every(id => submittedSet.has(id));
      if (!setsMatch) throw new Error('bad_request');
      playlist.projectIds = projectIds.map(id => new mongoose.Types.ObjectId(id));
      await playlist.save();
      return formatPlaylist(playlist.toObject() as LeanPlaylist, context);
    },

    savePlaylist: async (_root: unknown, { playlistId }: { playlistId: string }, context: Context) => {
      if (!context.userId) throw new Error('unauthorized');
      const playlist = await Playlist.findById(playlistId).lean<LeanPlaylist>();
      if (!playlist || !playlist.isPublic) throw new Error('not_found');
      try {
        await SavedPlaylist.create({
          userId: context.userId,
          playlistId: new mongoose.Types.ObjectId(playlistId),
          savedAt: new Date(),
        });
        await Playlist.updateOne({ _id: playlistId }, { $inc: { savedCount: 1 } });
      } catch (err: unknown) {
        if ((err as { code?: number }).code !== 11000) throw err;
        // duplicate key = already saved, silent
      }
      return true;
    },

    unsavePlaylist: async (_root: unknown, { playlistId }: { playlistId: string }, context: Context) => {
      if (!context.userId) throw new Error('unauthorized');
      const result = await SavedPlaylist.deleteOne({
        userId: new mongoose.Types.ObjectId(context.userId),
        playlistId: new mongoose.Types.ObjectId(playlistId),
      });
      if (result.deletedCount > 0) {
        await Playlist.updateOne(
          { _id: playlistId, savedCount: { $gt: 0 } },
          { $inc: { savedCount: -1 } }
        );
      }
      return true;
    },
  },
};
