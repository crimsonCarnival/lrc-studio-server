import mongoose from 'mongoose';
import Notification, { type INotification } from '../notifications/notification.model.js';
import { enqueueNotif } from '../../lib/notification-heap.js';
import { getIO } from '../../socket/socket.manager.js';

/**
 * Tells a submitter their catalog entry was approved or rejected. Unlike badge
 * notifications there is no preference gate: it answers the user's own submission.
 * `meta` carries the entry kind (so the client can say artist or album) and, on a
 * rejection, the note; the body stays the entry name. On an approval, `link` carries the slugs of
 * the new page (`slug`, plus `artistSlug` for an album) so the client can open it.
 */
export async function notifyCatalogReviewed(
  userId: string,
  kind: 'artist' | 'album',
  decision: 'approve' | 'reject',
  entryName: string,
  note: string,
  link?: { slug: string; artistSlug?: string },
): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: decision === 'approve' ? 'catalog_approved' : 'catalog_rejected',
    read: false,
    sticky: false,
    body: entryName,
    meta: { kind, ...(decision === 'reject' && note ? { note } : {}), ...(decision === 'approve' && link ? link : {}) },
  });
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
  try {
    getIO().to(`user:${userId}`).emit('notification:push', notification.toObject());
  } catch { /* socket not ready */ }
}
