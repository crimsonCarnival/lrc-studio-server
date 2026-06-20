import { Context } from './context.js';
import { reactToProject, getProjectReactions } from '../../modules/reactions/reaction.service.js';

export const reactionResolvers = {
  Query: {
    projectReactions: async (_: unknown, { publicId }: { publicId: string }, ctx: Context) =>
      getProjectReactions(publicId, ctx.userId ?? undefined),
  },
  Mutation: {
    reactToProject: async (_: unknown, { publicId, emoji }: { publicId: string; emoji: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthorized');
      return reactToProject(publicId, ctx.userId, emoji);
    },
  },
};
