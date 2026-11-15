import mongoose from 'mongoose';
import Notification, { type INotification } from '../notifications/notification.model.js';
import { enqueueNotif } from '../../lib/notification-heap.js';
import { getIO } from '../../socket/socket.manager.js';

/**
 * Tells a submitter their catalog entry was approved or rejected. Unlike badge
 * notifications there is no preference gate: it answers the user's own submission.
 * The rejection note travels in `meta` so the body stays the entry name.
 */
export async function notifyCatalogReviewed(
  userId: string,
  decision: 'approve' | 'reject',
  entryName: string,
  note: string,
): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: decision === 'approve' ? 'catalog_approved' : 'catalog_rejected',
    read: false,
    sticky: false,
    body: entryName,
    meta: decision === 'reject' && note ? { note } : null,
  });
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
  try {
    getIO().to(`user:${userId}`).emit('notification:push', notification.toObject());
  } catch { /* socket not ready */ }
}
