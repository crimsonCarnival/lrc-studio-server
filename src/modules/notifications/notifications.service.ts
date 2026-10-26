import mongoose from 'mongoose';
import type { FlattenMaps } from 'mongoose';
import Notification, { type INotification, type NotificationType } from './notification.model.js';
import { getIO } from '../../socket/socket.manager.js';
import Follow from '../users/follow.model.js';
import User from '../users/user.model.js';
import { enqueueNotif, enqueueNotifIfLoaded, peekNotifs, loadHeap, clearHeap } from '../../lib/notification-heap.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import { getCachedBlockedSet } from '../blocks/block-list.cache.js';

// Nothing reaches a user from someone in a block relationship with them.
async function blockedBetween(ownerId: string, actorId: string): Promise<boolean> {
  return (await getCachedBlockedSet(ownerId)).has(actorId);
}

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
  /** For forks: the new project, so the notification can open it rather than the source. */
  forkPublicId?: string;
}

export async function upsertSocial(params: UpsertSocialParams): Promise<void> {
  const { ownerId, type, publicId, projectTitle, actorId, actorAccountName, actorAvatarUrl, forkPublicId } = params;
  if (ownerId === actorId) return;
  if (await blockedBetween(ownerId, actorId)) return;

  const prefs = await getPreferences(ownerId);
  const prefKey = type as keyof typeof prefs.notifications;
  if (prefs.notifications[prefKey] === false) return;

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
      // Several forks of one project share this notification; it points at the latest.
      $set: { read: false, projectTitle, ...(forkPublicId ? { meta: { forkPublicId, forkOwner: actorAccountName } } : {}) },
      $addToSet: { actors: actor },
      $inc: { actorCount: 1 },
    },
    { upsert: true, returnDocument: 'after' }
  );

  enqueueNotif(ownerId, notification.toObject() as unknown as INotification);
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
  if (await blockedBetween(ownerId, actorId)) return;

  const prefs = await getPreferences(ownerId);
  if (!prefs.notifications.reaction) return;

  const actor = { userId: new mongoose.Types.ObjectId(actorId), accountName: actorAccountName, avatarUrl: actorAvatarUrl };

  const notification = await Notification.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(ownerId), type: 'reaction', publicId },
    {
      $setOnInsert: { sticky: false },
      $set: { read: false, projectTitle, body: emoji },
      $addToSet: { actors: actor },
      $inc: { actorCount: 1 },
    },
    { upsert: true, returnDocument: 'after' }
  );

  enqueueNotif(ownerId, notification.toObject() as unknown as INotification);
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
  if (await blockedBetween(ownerId, actorId)) return;

  const prefs = await getPreferences(ownerId);
  if (!prefs.notifications.follow) return;

  const actor = {
    userId: new mongoose.Types.ObjectId(actorId),
    accountName: actorAccountName,
    avatarUrl: actorAvatarUrl,
  };

  // actorCount tracks how many people have followed since the notification was created/reset.
  // actors[] keeps the 5 most recent actors for avatar display.
  const notification = await Notification.findOneAndUpdate(
    { userId: new mongoose.Types.ObjectId(ownerId), type: 'follow' },
    {
      $setOnInsert: { sticky: false, body: null, publicId: null, projectTitle: null, actorCount: 0 },
      $set: { read: false },
      $inc: { actorCount: 1 },
      $push: {
        actors: {
          $each: [actor],
          $slice: -5,
        },
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  enqueueNotif(ownerId, notification.toObject() as unknown as INotification);
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
  enqueueNotif(reviewerId, notification.toObject() as unknown as INotification);
  emitToUser(reviewerId, 'notification:push', notification.toObject());
}

export async function notifyRequestReviewed(requesterId: string, requestId: string, summary: string, approved: boolean): Promise<void> {
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(requesterId),
    type: 'request_reviewed',
    sticky: false, body: `${approved ? '✓' : '✗'} ${summary}`, publicId: requestId, projectTitle: null,
    actors: [], actorCount: 0, read: false,
  });
  enqueueNotif(requesterId, notification.toObject() as unknown as INotification);
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
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
  emitToUser(userId, 'notification:push', notification.toObject());
}

// Admin XP grant/revoke applied to a user. `meta` carries before -> after so
// the client can render the change without a reload.
export async function notifyXpChanged(userId: string, delta: number, before: number, after: number): Promise<void> {
  const prefs = await getPreferences(userId);
  if (!prefs.notifications.xp_changed) return;

  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'xp_changed',
    sticky: false,
    body: `${delta >= 0 ? '+' : ''}${delta} XP`,
    publicId: null, projectTitle: null, actors: [], actorCount: 0, read: false,
    meta: { delta, before, after },
  });
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
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
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
  emitToUser(userId, 'notification:push', notification.toObject());
}

export interface StreakWarningParams {
  userId: string;
  current: number;
  /** UTC day ('YYYY-MM-DD') on whose 00:00 UTC rollover the streak ends. */
  day: string;
  /** Most recently updated project, used as the "continue working" link. */
  publicId: string | null;
  projectTitle: string | null;
}

// Streak about to end. Preference and idempotency checks are done by the
// streak-warning job in batch; this only creates and delivers.
export async function notifyStreakWarning(params: StreakWarningParams): Promise<void> {
  const { userId, current, day, publicId, projectTitle } = params;
  const notification = await Notification.create({
    userId: new mongoose.Types.ObjectId(userId),
    type: 'streak_warning',
    sticky: false,
    body: null,
    publicId, projectTitle, actors: [], actorCount: 0, read: false,
    meta: { current, day },
  });
  enqueueNotifIfLoaded(userId, notification.toObject() as unknown as INotification);
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
  enqueueNotif(userId, notification.toObject() as unknown as INotification);
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
      enqueueNotif(userId, notification.toObject() as unknown as INotification);
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

/**
 * Actor avatars are copied in when a notification is written, and the old
 * file is deleted when its owner replaces it, so the copy would render as a
 * broken image. One query swaps in each actor's current avatar.
 */
async function withCurrentAvatars(notifications: INotification[]): Promise<INotification[]> {
  const actorIds = new Set<string>();
  for (const n of notifications) for (const a of n.actors ?? []) if (a.userId) actorIds.add(String(a.userId));
  if (actorIds.size === 0) return notifications;

  const users = await User.find({ _id: { $in: [...actorIds] } })
    .select('avatarUrl')
    .lean<Array<{ _id: mongoose.Types.ObjectId; avatarUrl?: string | null }>>();
  const avatarOf = new Map(users.map((u) => [u._id.toString(), u.avatarUrl ?? null]));

  return notifications.map((n) => ({
    ...n,
    actors: (n.actors ?? []).map((a) => {
      const id = String(a.userId);
      // Deleted users keep the stored copy; there is nothing newer.
      return avatarOf.has(id) ? { ...a, avatarUrl: avatarOf.get(id)! } : a;
    }),
  }));
}

export async function listNotifications(
  userId: string
): Promise<{ notifications: NotificationDoc[]; unreadCount: number }> {
  // Returns unread notifications ordered by priority (heap). Previously returned all notifications by recency.
  const userObjId = new mongoose.Types.ObjectId(userId);
  const blockedSet = await getCachedBlockedSet(userId);
  const blockedIds = [...blockedSet].map((id) => new mongoose.Types.ObjectId(id));
  // Unread, not counting anything that only came from users in a block
  // relationship with this user: either it has no actors at all (badges, XP,
  // staff requests) or at least one actor who is not blocked.
  const unreadFilter = blockedIds.length === 0
    ? { userId: userObjId, read: false }
    : {
        userId: userObjId,
        read: false,
        $or: [
          { 'actors.0': { $exists: false } },
          { actors: { $elemMatch: { userId: { $nin: blockedIds } } } },
        ],
      };
  const [unread, unreadCount] = await Promise.all([
    getPrioritizedUnread(userId, 50),
    Notification.countDocuments(unreadFilter),
  ]);
  const prioritized = await withCurrentAvatars(unread);
  if (blockedSet.size === 0) return { notifications: prioritized as unknown as NotificationDoc[], unreadCount };

  // Received before the block: drop the blocked actors, and the notification
  // itself when nobody else is left on it. Notifications without actors are untouched.
  const visible: INotification[] = [];
  for (const n of prioritized) {
    const actors = (n.actors ?? []).filter((a) => !blockedSet.has(String(a.userId)));
    const removed = (n.actors?.length ?? 0) - actors.length;
    if (removed === 0) { visible.push(n); continue; }
    if (actors.length === 0) continue;
    visible.push({ ...n, actors, actorCount: Math.max(actors.length, (n.actorCount ?? 0) - removed) } as INotification);
  }
  return { notifications: visible as unknown as NotificationDoc[], unreadCount };
}

export async function markRead(userId: string, ids: string[]): Promise<void> {
  await Notification.updateMany(
    {
      _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) },
      userId: new mongoose.Types.ObjectId(userId),
    },
    { $set: { read: true } }
  );
  clearHeap(userId);
}

export async function markAllRead(userId: string): Promise<void> {
  await Notification.updateMany(
    { userId: new mongoose.Types.ObjectId(userId), read: false },
    { $set: { read: true } }
  );
  clearHeap(userId);
}

// Returns prioritized unread notifications for a user. Uses the in-memory heap
// when available (user is connected); falls back to DB if heap not loaded.
export async function getPrioritizedUnread(
  userId: string,
  limit: number
): Promise<INotification[]> {
  const cached = peekNotifs(userId, limit)
  if (cached.length > 0) return cached
  // Fallback: load from DB and populate heap (e.g. REST request without socket)
  await loadHeap(userId)
  return peekNotifs(userId, limit)
}

export async function dismiss(userId: string, id: string): Promise<void> {
  await Notification.deleteOne({
    _id: new mongoose.Types.ObjectId(id),
    userId: new mongoose.Types.ObjectId(userId),
    sticky: { $ne: true },
  });
}
