import mercurius from 'mercurius';
import { Context } from './context.js';
import {
  CollabError, createInvite, endSession, getSessionView, kick, removeProjectCollaborator, revokeInvite, setGuestAccess, setRole, startSession,
} from '../../modules/collab/collab.service.js';

// The client switches on `extensions.code` (collab_invalid_role, forbidden, ...).
async function guarded<T>(ctx: Context, run: () => Promise<T>): Promise<T> {
  // An expired access token reads as signed out; answer unauthorized so the client
  // refreshes instead of showing a failed owner check (same as updateProject).
  if (ctx.tokenExpired) throw new mercurius.ErrorWithProps('unauthorized', { code: 'unauthorized' });
  try {
    return await run();
  } catch (err) {
    if (err instanceof CollabError) throw new mercurius.ErrorWithProps(err.code, { code: err.code });
    throw err;
  }
}

type ById = { publicId: string };

export const collabResolvers = {
  Query: {
    collabSession: (_: unknown, { publicId }: ById, ctx: Context) =>
      guarded(ctx, () => getSessionView(publicId, ctx.userId)),
  },
  Mutation: {
    startCollabSession: (_: unknown, { publicId }: ById, ctx: Context) =>
      guarded(ctx, () => startSession(publicId, ctx.userId)),
    endCollabSession: (_: unknown, { publicId }: ById, ctx: Context) =>
      guarded(ctx, () => endSession(publicId, ctx.userId)),
    createCollabInvite: (_: unknown, { publicId, role }: ById & { role: string }, ctx: Context) =>
      guarded(ctx, () => createInvite(publicId, role, ctx.userId)),
    revokeCollabInvite: (_: unknown, { publicId, inviteId }: ById & { inviteId: string }, ctx: Context) =>
      guarded(ctx, () => revokeInvite(publicId, inviteId, ctx.userId)),
    setCollabRole: (_: unknown, { publicId, subject, role }: ById & { subject: string; role: string }, ctx: Context) =>
      guarded(ctx, () => setRole(publicId, subject, role, ctx.userId)),
    kickCollabParticipant: (_: unknown, { publicId, subject }: ById & { subject: string }, ctx: Context) =>
      guarded(ctx, () => kick(publicId, subject, ctx.userId)),
    setCollabGuestAccess: (_: unknown, { publicId, allowGuests }: ById & { allowGuests: boolean }, ctx: Context) =>
      guarded(ctx, () => setGuestAccess(publicId, allowGuests, ctx.userId)),
    removeProjectCollaborator: (_: unknown, { publicId, id }: ById & { id: string }, ctx: Context) =>
      guarded(ctx, () => removeProjectCollaborator(publicId, id, ctx.userId)),
  },
};
