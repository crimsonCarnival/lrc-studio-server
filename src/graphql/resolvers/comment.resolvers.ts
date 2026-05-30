import { Context } from './context.js';
import { getComments, getCommentReplies, addComment, deleteComment } from '../../modules/comments/comment.service.js';
import { reactToCommentFull, reactToProject, getProjectReactions } from '../../modules/reactions/reaction.service.js';

export const commentResolvers: any = {
  Query: {
    comments: async (
      _: unknown,
      { projectId, offset = 0, limit = 20 }: { projectId: string; offset?: number; limit?: number },
      ctx: Context
    ) => getComments(projectId, offset, Math.min(limit, 50), ctx.userId ?? undefined),

    commentReplies: async (
      _: unknown,
      { commentId, offset = 0, limit = 20 }: { commentId: string; offset?: number; limit?: number },
      ctx: Context
    ) => getCommentReplies(commentId, offset, Math.min(limit, 50), ctx.userId ?? undefined),

    projectReactions: async (
      _: unknown,
      { projectId }: { projectId: string },
      ctx: Context
    ) => getProjectReactions(projectId, ctx.userId ?? undefined),
  },

  Mutation: {
    addComment: async (
      _: unknown,
      { projectId, text, parentId }: { projectId: string; text: string; parentId?: string | null },
      ctx: Context
    ) => {
      const userId = ctx.userId ?? undefined;
      if (!userId) throw new Error('Unauthorized');
      return addComment(projectId, userId, text, parentId ?? undefined);
    },

    deleteComment: async (
      _: unknown,
      { id }: { id: string },
      ctx: Context
    ) => {
      const userId = ctx.userId ?? undefined;
      if (!userId) throw new Error('Unauthorized');
      return deleteComment(id, userId);
    },

    reactToComment: async (
      _: unknown,
      { commentId, emoji }: { commentId: string; emoji: string },
      ctx: Context
    ) => {
      const userId = ctx.userId ?? undefined;
      if (!userId) throw new Error('Unauthorized');
      return reactToCommentFull(commentId, userId, emoji);
    },

    reactToProject: async (
      _: unknown,
      { projectId, emoji }: { projectId: string; emoji: string },
      ctx: Context
    ) => {
      const userId = ctx.userId ?? undefined;
      if (!userId) throw new Error('Unauthorized');
      return reactToProject(projectId, userId, emoji);
    },
  },
};
