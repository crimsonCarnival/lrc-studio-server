import { getIO } from '../../socket/socket.manager.js';

/**
 * Broadcasts a project change to everyone in that project's room.
 *
 * This file no longer serves any REST route — project CRUD is GraphQL. It
 * survives only because the resolvers call this helper, which is why it is not
 * deleted along with the handlers it used to sit beside.
 */
export function emitProjectUpdated(publicId: string, patch: Record<string, unknown>): void {
  try {
    getIO().to(`project:${publicId}`).emit('project:updated', { publicId, ...patch });
  } catch {
    // socket not initialized — safe to ignore
  }
}
