import mercurius from 'mercurius';
import { Context } from './context.js';
import { getWall, addComment, deleteComment, setSubscription, WallError } from '../../modules/wall/wall.service.js';

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
    wall: (_: unknown, args: { accountName: string; after?: string | null; limit?: number | null }, ctx: Context) =>
      guarded(() => getWall(ctx.userId ?? null, args.accountName, { after: args.after, limit: args.limit })),
  },
  Mutation: {
    addWallComment: (_: unknown, args: { accountName: string; body: string; parentId?: string | null }, ctx: Context) =>
      guarded(() => addComment(requireUser(ctx), args.accountName, args.body, args.parentId)),
    deleteWallComment: (_: unknown, args: { id: string }, ctx: Context) =>
      guarded(() => deleteComment(requireUser(ctx), args.id)),
    setWallSubscription: (_: unknown, args: { accountName: string; subscribed: boolean }, ctx: Context) =>
      guarded(() => setSubscription(requireUser(ctx), args.accountName, args.subscribed)),
  },
};
