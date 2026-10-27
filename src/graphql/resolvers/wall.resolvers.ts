import mercurius from 'mercurius';
import { Context } from './context.js';
import {
  getWall, getReplies, getComment, getLikers, addComment, editComment, deleteComment, setLike, setPin,
  setSubscription, reportComment, listReports, resolveReport, WallError,
} from '../../modules/wall/wall.service.js';

// The client switches on `extensions.code`, so a WallError keeps its code.
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WallError) throw new mercurius.ErrorWithProps(err.code, { code: err.code.toUpperCase() });
    throw err;
  }
}

function requireUser(ctx: Context): string {
  if (!ctx.userId) throw new mercurius.ErrorWithProps('UNAUTHORIZED', { code: 'UNAUTHORIZED' });
  return ctx.userId;
}

export const wallResolvers = {
  Query: {
    // `after` is accepted for clients from before page numbers, and ignored.
    wall: (_: unknown, args: { accountName: string; page?: number | null; limit?: number | null; focus?: string | null }, ctx: Context) =>
      guarded(() => getWall(ctx.userId ?? null, args.accountName, { page: args.page, limit: args.limit, focus: args.focus })),
    wallReplies: (_: unknown, args: { commentId: string; offset?: number | null; limit?: number | null }, ctx: Context) =>
      guarded(() => getReplies(ctx.userId ?? null, args.commentId, args.offset ?? 0, args.limit ?? 10)),
    wallComment: (_: unknown, args: { id: string }, ctx: Context) =>
      guarded(() => getComment(ctx.userId ?? null, args.id)),
    wallCommentLikers: (_: unknown, args: { id: string; limit?: number | null }, ctx: Context) =>
      guarded(() => getLikers(ctx.userId ?? null, args.id, args.limit ?? 20)),
    wallReports: (_: unknown, args: { status?: 'open' | 'dismissed' | 'actioned' | null }, ctx: Context) =>
      guarded(() => listReports(requireUser(ctx), args.status ?? 'open')),
  },
  Mutation: {
    addWallComment: (_: unknown, args: { accountName: string; body: string; parentId?: string | null }, ctx: Context) =>
      guarded(() => addComment(requireUser(ctx), args.accountName, args.body, args.parentId)),
    editWallComment: (_: unknown, args: { id: string; body: string }, ctx: Context) =>
      guarded(() => editComment(requireUser(ctx), args.id, args.body)),
    deleteWallComment: (_: unknown, args: { id: string }, ctx: Context) =>
      guarded(() => deleteComment(requireUser(ctx), args.id)),
    setWallCommentLike: (_: unknown, args: { id: string; liked: boolean }, ctx: Context) =>
      guarded(() => setLike(requireUser(ctx), args.id, args.liked)),
    setWallCommentPin: (_: unknown, args: { id: string; pinned: boolean }, ctx: Context) =>
      guarded(() => setPin(requireUser(ctx), args.id, args.pinned)),
    reportWallComment: (_: unknown, args: { id: string; reason: string; note?: string | null }, ctx: Context) =>
      guarded(() => reportComment(requireUser(ctx), args.id, args.reason, args.note)),
    resolveWallReport: (_: unknown, args: { id: string; action: 'dismiss' | 'delete' }, ctx: Context) =>
      guarded(() => resolveReport(requireUser(ctx), args.id, args.action)),
    setWallSubscription: (_: unknown, args: { accountName: string; subscribed: boolean }, ctx: Context) =>
      guarded(() => setSubscription(requireUser(ctx), args.accountName, args.subscribed)),
  },
};
