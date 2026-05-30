import { Context } from './context.js';
import { reactToProject, getProjectReactions } from '../../modules/reactions/reaction.service.js';

export const commentResolvers = {
  Query: {
    projectReactions: async (_: unknown, { projectId }: { projectId: string }, ctx: Context) =>
      getProjectReactions(projectId, ctx.userId ?? undefined),
  },
  Mutation: {
    reactToProject: async (_: unknown, { projectId, emoji }: { projectId: string; emoji: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthorized');
      return reactToProject(projectId, ctx.userId, emoji);
    },
  },
};
