import { Context } from './context.js';
import { reactToProject, getProjectReactions } from '../../modules/reactions/reaction.service.js';
import Project from '../../modules/projects/project.model.js';
import { isHiddenByBlock, ownerIdOf } from '../../modules/blocks/block.service.js';

// A project whose owner is in a block relationship with the viewer does not exist for them.
async function hiddenProject(publicId: string, viewerId?: string | null): Promise<boolean> {
  if (!viewerId) return false;
  const project = await Project.findOne({ publicId }).select('userId').lean<{ userId?: unknown }>();
  return project ? isHiddenByBlock(viewerId, ownerIdOf(project)) : false;
}

export const reactionResolvers = {
  Query: {
    projectReactions: async (_: unknown, { publicId }: { publicId: string }, ctx: Context) => {
      if (await hiddenProject(publicId, ctx.userId)) return { reactions: [], myReaction: null };
      return getProjectReactions(publicId, ctx.userId ?? undefined);
    },
  },
  Mutation: {
    reactToProject: async (_: unknown, { publicId, emoji }: { publicId: string; emoji: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthorized');
      if (await hiddenProject(publicId, ctx.userId)) throw new Error('Project not found');
      return reactToProject(publicId, ctx.userId, emoji);
    },
  },
};
