import Project from '../../modules/projects/project.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import { Context } from './context.js';
import { recomputeSyncStats, triggerBadgeCheck, updateStreak } from '../../modules/badges/badge.service.js';

export const lyricsResolvers = {
  Mutation: {
    updateLyrics: async (_root: any, { projectId, input }: { projectId: string; input: any }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const project = await Project.findOne({ projectId, userId: context.userId });
      if (!project) throw new Error('Project not found or access denied');
      const result = await Lyrics.findOneAndUpdate(
        { projectId },
        { $set: input },
        { new: true, upsert: true }
      );
      // Fire-and-forget: recompute stats then check badges
      Promise.all([
        recomputeSyncStats(context.userId),
        updateStreak(context.userId),
      ]).then(() => triggerBadgeCheck(context.userId!, 'sync_update')).catch(() => {});
      return result;
    },
  },

  Lyrics: {
    id: (lyrics: any) => lyrics._id?.toString() ?? lyrics.id,
    createdAt: (lyrics: any) => lyrics.createdAt ? new Date(lyrics.createdAt).toISOString() : null,
    updatedAt: (lyrics: any) => lyrics.updatedAt ? new Date(lyrics.updatedAt).toISOString() : null,
  },
};
