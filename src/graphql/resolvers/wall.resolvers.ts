import mercurius from 'mercurius';
import { Context } from './context.js';
import {
  getWall, getReplies, getComment, getLikers, addComment, editComment, deleteComment, setLike, setPin,
  setSubscription, WallError, getCommentHistory, moderateComment, purgeAuthorComments,
  blockCommenter, setThreadMute, setReaction, restrictCommenter, liftRestriction,
} from '../../modules/wall/wall.service.js';
import { ReportError } from '../../modules/reports/reports.service.js';
// The wall-only report fields, kept for the client released before generic reports.
import {
  reportWallComment, listWallReports, listWallReportGroups, wallOpenReportCount, listMyWallReports, resolveWallReport,
} from '../../modules/reports/reports.legacy.js';

// The client switches on `extensions.code`, so a WallError (or ReportError) keeps its code.
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof WallError || err instanceof ReportError) throw new mercurius.ErrorWithProps(err.code, { code: err.code.toUpperCase() });
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
    wall: (_: unknown, args: { accountName: string; page?: number | null; limit?: number | null; focus?: string | null; sort?: string | null }, ctx: Context) =>
      guarded(() => getWall(ctx.userId ?? null, args.accountName, { page: args.page, limit: args.limit, focus: args.focus, sort: args.sort })),
    wallReplies: (_: unknown, args: { commentId: string; offset?: number | null; limit?: number | null }, ctx: Context) =>
      guarded(() => getReplies(ctx.userId ?? null, args.commentId, args.offset ?? 0, args.limit ?? 10)),
    wallComment: (_: unknown, args: { id: string }, ctx: Context) =>
      guarded(() => getComment(ctx.userId ?? null, args.id)),
    wallCommentLikers: (_: unknown, args: { id: string; limit?: number | null }, ctx: Context) =>
      guarded(() => getLikers(ctx.userId ?? null, args.id, args.limit ?? 20)),
    wallReports: (_: unknown, args: { status?: 'open' | 'dismissed' | 'actioned' | null }, ctx: Context) =>
      guarded(() => listWallReports(requireUser(ctx), args.status ?? 'open')),
    wallReportGroups: (_: unknown, args: { status?: 'open' | 'dismissed' | 'actioned' | null; limit?: number | null }, ctx: Context) =>
      guarded(() => listWallReportGroups(requireUser(ctx), args.status ?? 'open', args.limit ?? 30)),
    wallOpenReportCount: async (_: unknown, __: unknown, ctx: Context) =>
      guarded(() => wallOpenReportCount(requireUser(ctx))),
    myWallReports: (_: unknown, args: { limit?: number | null; offset?: number | null }, ctx: Context) =>
      guarded(() => listMyWallReports(requireUser(ctx), args.limit ?? 50, args.offset ?? 0)),
    wallCommentHistory: (_: unknown, args: { id: string }, ctx: Context) =>
      guarded(() => getCommentHistory(ctx.userId ?? null, args.id)),
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
      guarded(() => reportWallComment(requireUser(ctx), args.id, args.reason, args.note)),
    resolveWallReport: (_: unknown, args: { id: string; action: 'dismiss' | 'delete' }, ctx: Context) =>
      guarded(() => resolveWallReport(requireUser(ctx), args.id, args.action, ctx.ip)),
    setWallSubscription: (_: unknown, args: { accountName: string; subscribed: boolean }, ctx: Context) =>
      guarded(() => setSubscription(requireUser(ctx), args.accountName, args.subscribed)),
    moderateWallComment: (_: unknown, args: { id: string; action: string }, ctx: Context) =>
      guarded(() => {
        if (!['approve', 'reject', 'hide', 'unhide'].includes(args.action)) throw new WallError('invalid_body');
        return moderateComment(requireUser(ctx), args.id, args.action as 'approve' | 'reject' | 'hide' | 'unhide', ctx.ip);
      }),
    purgeWallComments: (_: unknown, args: { accountName: string; authorId: string }, ctx: Context) =>
      guarded(() => purgeAuthorComments(requireUser(ctx), args.accountName, args.authorId, ctx.ip)),
    blockWallCommenter: (_: unknown, args: { authorId: string }, ctx: Context) =>
      guarded(() => blockCommenter(requireUser(ctx), args.authorId)),
    setWallThreadMute: (_: unknown, args: { id: string; muted: boolean }, ctx: Context) =>
      guarded(() => setThreadMute(requireUser(ctx), args.id, args.muted)),
    setWallCommentReaction: (_: unknown, args: { id: string; emoji: string; on: boolean }, ctx: Context) =>
      guarded(() => setReaction(requireUser(ctx), args.id, args.emoji, args.on)),
    restrictWallCommenter: (_: unknown, args: { userId: string; hours?: number | null; reason?: string | null }, ctx: Context) =>
      guarded(() => restrictCommenter(requireUser(ctx), args.userId, args.hours ?? null, args.reason, ctx.ip)),
    liftWallRestriction: (_: unknown, args: { userId: string }, ctx: Context) =>
      guarded(() => liftRestriction(requireUser(ctx), args.userId, ctx.ip)),
  },
};
