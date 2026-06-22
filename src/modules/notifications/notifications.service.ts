import mongoose from 'mongoose';
import type { FlattenMaps } from 'mongoose';
import Notification, { type INotification, type NotificationType } from './notification.model.js';
import { getIO } from '../../socket/socket.manager.js';
import Follow from '../../db/follow.model.js';

export type NotificationDoc = FlattenMaps<INotification> & { _id: mongoose.Types.ObjectId };

function emitToUser(userId: string, event: string, payload: unknown): void {
  try { getIO().to(`user:${userId}`).emit(event, payload); } catch { /* socket not ready */ }
}

export interface UpsertSocialParams {
  ownerId: string;
  type: 'star' | 'fork';
  publicId: string;
  projectTitle: string;
  actorId: string;
  actorAccountName: string;
  actorAvatarUrl: string | null;
}

export async function upsertSocial(params: UpsertSocialParams): Promise<void> {
  const { ownerId, type, publicId, projectTitle, actorId, actorAccountName, actorAvatarUrl } = params;
  if (ownerId === actorId) return;

  const actor = {
    userId: new mongoose.Types.ObjectId(actorId),
    accountName: actorAccountName,
    avatarUrl: actorAvatarUrl,
  };

  // actorCount tracks total star/fork events (may overcount if same actor re-stars).
  // actors[] is deduplicated via $addToSet for display; actorCount is the display hint for "and N others".
  const notification = await Notification.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(ownerId), type, publicId },
    {
      $setOnInsert: { sticky: false, body: null },
      $set: { read: false, projectTitle },
      $addToSet: { actors: actor },
      $inc: { actorCount: 1 },
    },
    { upsert: true, new: true }
  );

  emitToUser(ownerId, 'notification:push', notification.toObject());
}

export interface UpsertReactionParams {
  ownerId: string;
  publicId: string;
  projectTitle: string;
  actorId: string;
  actorAccountName: string;
  actorAvatarUrl: string | null;
  emoji: string;
}

export async function upsertReaction(params: UpsertReactionParams): Promise<void> {
  const { ownerId, publicId, projectTitle, actorId, actorAccountName, actorAvatarUrl, emoji } = params;
  if (ownerId === actorId) return;

  const actor = { userId: new mongoose.Types.ObjectId(actorId), accountName: actorAccountName, avatarUrl: actorAvatarUrl };

  const notification = await Notification.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(ownerId), type: 'reaction', publicId },
    {
      $setOnInsert: { sticky: false },
      $set: { read: false, projectTitle, body: emoji },
      $addToSet: { actors: actor },
      $inc: { actorCount: 1 },
    },
    { upsert: true, new: true }
  );

  emitToUser(ownerId, 'notification:push', notification.toObject());
}

export interface UpsertFollowParams {
  ownerId: string;
  actorId: string;
  actorAccountName: string;
  actorAvatarUrl: string | null;
}

export async function upsertFollow(params: UpsertFollowParams): Promise<void> {
  const { ownerId, actorId, actorAccountName, actorAvatarUrl } = params;
  if (ownerId === actorId) return;

  const actor = {
    userId: new mongoose.Types.ObjectId(actorId),
    accountName: actorAccountName,
    avatarUrl: actorAvatarUrl,
  };

  // Count total followers for accurate actorCount
  const totalFollowers = await Follow.countDocuments({ followingId: new mongoose.Types.ObjectId(ownerId) });

  const notification = await Notification.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(ownerId), type: 'follow' },
    {
      $setOnInsert: { sticky: false, body: null, publicId: null, projectTitle: null },
      $set: { read: false, actorCount: totalFollowers },
      $push: {
        actors: {
          $each: [actor],
          $slice: -5,  // keep 5 most recent actors
        },
      },
    },
    { upsert: true, new: true }
  );

  emitToUser(ownerId, 'notification:push', notification.toObject());
}

// Staff request workflow notifications. `body` carries the human-readable
// summary; `projectTitle` is reused to carry the request id for deep-linking.
export async function notifyRequestSubmitted(reviewerId: string, requestId: string, summary: string): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(reviewerId),
    type: 'request_submitted',
    sticky: false, body: summary, publicId: requestId, projectTitle: null,
    actors: [], actorCount: 0, read: false,
  });
  emitToUser(reviewerId, 'notification:push', notification.toObject());
}

export async function notifyRequestReviewed(requesterId: string, requestId: string, summary: string, approved: boolean): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(requesterId),
    type: 'request_reviewed',
    sticky: false, body: `${approved ? '✓' : '✗'} ${summary}`, publicId: requestId, projectTitle: null,
    actors: [], actorCount: 0, read: false,
  });
  emitToUser(requesterId, 'notification:push', notification.toObject());
}

export async function notifyAdminGranted(userId: string): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'admin_granted',
    sticky: false,
    body: null,
    publicId: null,
    projectTitle: null,
    actors: [],
    actorCount: 0,
    read: false,
  });
  emitToUser(userId, 'notification:push', notification.toObject());
}

// Admin XP grant/revoke applied to a user. `meta` carries before -> after so
// the client can render the change without a reload.
export async function notifyXpChanged(userId: string, delta: number, before: number, after: number): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'xp_changed',
    sticky: false,
    body: `${delta >= 0 ? '+' : ''}${delta} XP`,
    publicId: null, projectTitle: null, actors: [], actorCount: 0, read: false,
    meta: { delta, before, after },
  });
  emitToUser(userId, 'notification:push', notification.toObject());
}

// Admin role change. `meta.from`/`meta.to` drive the before -> after display.
export async function notifyRoleChanged(userId: string, from: string, to: string): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'role_changed',
    sticky: false,
    body: null,
    publicId: null, projectTitle: null, actors: [], actorCount: 0, read: false,
    meta: { from, to },
  });
  emitToUser(userId, 'notification:push', notification.toObject());
}

export async function notifyUnban(userId: string): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'unban',
    sticky: false,
    body: null,
    publicId: null, projectTitle: null, actors: [], actorCount: 0, read: false,
  });
  emitToUser(userId, 'notification:push', notification.toObject());
}

export async function createOnce(params: {
  userId: string;
  type: NotificationType;
  sticky: boolean;
  body?: string | null;
}): Promise<void> {
  const { userId, type, sticky, body = null } = params;
  const userObjId = new mongoose.Types.ObjectId(userId);

  // findOneAndUpdate with upsert is idempotent — no duplicate regardless of index state.
  // We check the pre-update doc (returnDocument: 'before') to know if we created vs found.
  const existing = await Notification.findOneAndUpdate(
    { userId: userObjId, type },
    {
      $setOnInsert: {
        sticky,
        body,
        publicId: null,
        projectTitle: null,
        actors: [],
        actorCount: 0,
        read: false,
      },
    },
    { upsert: true, new: false }
  );

  // Only emit on actual creation (existing is null when inserted)
  if (!existing) {
    const notification = await Notification.findOne({ userId: userObjId, type });
    if (notification) {
      emitToUser(userId, 'notification:push', notification.toObject());
    }
  }
}

export async function resolveSticky(
  userId: string,
  type: 'verify_email' | 'set_password'
): Promise<void> {
  const notification = await Notification.findOneAndDelete({
    userId: new mongoose.Types.ObjectId(userId),
    type,
  });
  if (notification) {
    emitToUser(userId, 'notification:dismissed', { id: notification._id.toString() });
  }
}

export async function listNotifications(
  userId: string
): Promise<{ notifications: NotificationDoc[]; unreadCount: number }> {
  const userObjId = new mongoose.Types.ObjectId(userId);
  const [notifications, unreadCount] = await Promise.all([
    Notification.find({ userId: userObjId }).sort({ createdAt: -1 }).limit(50).lean<NotificationDoc[]>(),
    Notification.countDocuments({ userId: userObjId, read: false }),
  ]);
  return { notifications, unreadCount };
}

export async function markRead(userId: string, ids: string[]): Promise<void> {
  await Notification.updateMany(
    {
      _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
      userId: new mongoose.Types.ObjectId(userId),
    },
    { $set: { read: true } }
  );
}

export async function markAllRead(userId: string): Promise<void> {
  await Notification.updateMany(
    { userId: new mongoose.Types.ObjectId(userId), read: false },
    { $set: { read: true } }
  );
}

export async function dismiss(userId: string, id: string): Promise<void> {
  await Notification.deleteOne({
    _id: new mongoose.Types.ObjectId(id),
    userId: new mongoose.Types.ObjectId(userId),
    sticky: { $ne: true },
  });
}
