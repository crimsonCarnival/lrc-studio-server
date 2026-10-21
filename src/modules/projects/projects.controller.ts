import { getIO } from '../../socket/socket.manager.js';

/**
 * Broadcasts a project change to everyone else in that project's room.
 *
 * This file no longer serves any REST route — project CRUD is GraphQL. It
 * survives only because the resolvers call this helper, which is why it is not
 * deleted along with the handlers it used to sit beside.
 */
export function emitProjectUpdated(publicId: string, patch: Record<string, unknown>, excludeSocketId?: string): void {
  try {
    // Excludes the saving client's own socket: without this, a client
    // subscribed to its own project's room (shared/collaborative sessions)
    // received its own save echoed back as a full `project:updated` payload
    // and applied it as if it were someone else's edit — wholesale
    // `setLines` replacement, which can clobber anything typed between the
    // save firing and the echo arriving, and needlessly costs a full patch
    // download on every save for no reason (the saving client already has
    // the state it just sent).
    const room = getIO().to(`project:${publicId}`);
    (excludeSocketId ? room.except(excludeSocketId) : room).emit('project:updated', { publicId, ...patch });
  } catch {
    // socket not initialized — safe to ignore
  }
}
