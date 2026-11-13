import { isDeepStrictEqual } from 'node:util';
import Project from '../../modules/projects/project.model.js';
import Lyrics from '../../modules/lyrics/lyrics.model.js';
import { Context } from './context.js';
import { scheduleSyncStatsRefresh, updateStreak } from '../../modules/badges/badge.service.js';
import { collabSessionBlocks, assertValidSectionsTiming } from '../../modules/projects/projects.crud.service.js';
import { unpublishIfIncomplete, type ReadinessSections } from '../../modules/projects/publish-readiness.js';
import { evictNonOwnersFromProjectRoom } from './project.resolvers.js';

export interface LyricsInput {
  [key: string]: unknown;
}

export interface LyricsDoc {
  _id?: { toString(): string };
  id?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export const lyricsResolvers = {
  Mutation: {
    updateLyrics: async (_root: unknown, { publicId, input }: { publicId: string; input: LyricsInput }, context: Context) => {
      if (!context.userId) throw new Error('Unauthorized');
      const project = await Project.findOne({ publicId, userId: context.userId });
      if (!project) throw new Error('Project not found or access denied');
      // Same guard as updateProject: a live session's next store would overwrite this write.
      const blocked = await collabSessionBlocks(publicId, { lyrics: input });
      if (blocked) throw Object.assign(new Error(blocked.error ?? 'collab_active'), { extensions: { code: blocked.code, status: blocked.status } });
      const update: Record<string, unknown> = {};
      if (input.editorMode !== undefined) update.editorMode = input.editorMode;
      if (input.sections !== undefined) {
        assertValidSectionsTiming(input.sections as unknown[]);
        update.sections = input.sections;
      }
      const before = await Lyrics.findOne({ publicId }).select('editorMode sections -_id').lean();
      const result = await Lyrics.findOneAndUpdate(
        { publicId },
        { $set: update, $unset: { lines: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      // Fire-and-forget. Stats and badges are coalesced per user; ranking is left
      // to the hourly job — recomputing every user's score per call let one
      // caller drive a full-collection rewrite on demand.
      // Only a real change is activity; re-sending identical lyrics must not keep a streak alive.
      const after = { editorMode: result?.editorMode, sections: result?.sections };
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(before ?? {})), JSON.parse(JSON.stringify(after)))) {
        updateStreak(context.userId).catch(() => {});
      }
      scheduleSyncStatsRefresh(context.userId);
      if (input.sections !== undefined && await unpublishIfIncomplete(publicId, project, result?.sections as ReadinessSections, true)) {
        await evictNonOwnersFromProjectRoom(publicId, context.userId);
      }
      return result;
    },
  },

  Lyrics: {
    id: (lyrics: LyricsDoc) => lyrics._id?.toString() ?? lyrics.id,
    createdAt: (lyrics: LyricsDoc) => lyrics.createdAt ? new Date(lyrics.createdAt).toISOString() : null,
    updatedAt: (lyrics: LyricsDoc) => lyrics.updatedAt ? new Date(lyrics.updatedAt).toISOString() : null,
  },
};
