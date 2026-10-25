import mongoose from 'mongoose';
import Notification, { type INotification, type NotificationType } from './notification.model.js';
import Follow from '../../db/follow.model.js';
import { getIO } from '../../socket/socket.manager.js';
import { enqueueNotif, enqueueNotifIfLoaded } from '../../lib/notification-heap.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import { getCachedBlockedSet } from '../blocks/block-list.cache.js';
import type { INotificationPrefs } from '../../db/user-preferences.model.js';

/**
 * Notifications for events that have no module of their own: a followed user's project, a
 * level-up, a saved playlist, a star milestone, a sign-in from a new device, an appeal's
 * outcome, and a comment on a profile wall. Each one checks the recipient's preference for
 * its type, and none reaches someone in a block relationship with the actor.
 */

type PrefKey = Extract<keyof INotificationPrefs, NotificationType>;

const oid = (id: string) => new mongoose.Types.ObjectId(id);

function emit(userId: string, notification: INotification): void {
  try { getIO().to(`user:${userId}`).emit('notification:push', notification); } catch { /* socket not ready */ }
}

interface Actor {
  userId: string;
  accountName: string;
  avatarUrl: string | null;
}

const actorDoc = (a: Actor) => ({ userId: oid(a.userId), accountName: a.accountName, avatarUrl: a.avatarUrl });

/**
 * Creates the recipient's notification, or folds this event into the unread one that already
 * matches `match` (more actors, bumped count). `match` also supplies the new document's
 * type and meta, so it must not be set again in `update`.
 */
async function deliver(
  recipientId: string,
  pref: PrefKey,
  match: Record<string, unknown>,
  update: Record<string, unknown>,
  { fanOut = false }: { fanOut?: boolean } = {},
): Promise<void> {
  const prefs = await getPreferences(recipientId);
  if (prefs.notifications[pref] === false) return;
  const doc = await Notification.findOneAndUpdate(
    { userId: oid(recipientId), ...match, read: false },
    update,
    { upsert: true, returnDocument: 'after' },
  );
  const plain = doc.toObject() as unknown as INotification;
  // A batch only touches heaps that are already loaded; offline users read from the DB.
  if (fanOut) enqueueNotifIfLoaded(recipientId, plain);
  else enqueueNotif(recipientId, plain);
  emit(recipientId, plain);
}

async function blocked(recipientId: string, actorId: string): Promise<boolean> {
  return (await getCachedBlockedSet(recipientId)).has(actorId);
}

// ─── Followed user's projects ────────────────────────────────────────────────

// An edit tells followers at most once per project per window, however many saves it takes.
const EDIT_NOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000;
const lastEditNotice = new Map<string, number>();
const MAX_FOLLOWER_FANOUT = 2000;

export async function notifyFollowedProject(params: {
  author: Actor;
  publicId: string;
  projectTitle: string;
  kind: 'published' | 'updated';
}): Promise<void> {
  const { author, publicId, projectTitle, kind } = params;
  if (kind === 'updated') {
    const last = lastEditNotice.get(publicId) ?? 0;
    if (Date.now() - last < EDIT_NOTIFY_WINDOW_MS) return;
    lastEditNotice.set(publicId, Date.now());
  }
  // "uploads" hears about new projects; "all" also hears about edits.
  const levels: Array<'uploads' | 'all'> = kind === 'published' ? ['uploads', 'all'] : ['all'];
  const followers = await Follow.find({ followingId: oid(author.userId), notify: { $in: levels } })
    .select('followerId')
    .limit(MAX_FOLLOWER_FANOUT)
    .lean<{ followerId: mongoose.Types.ObjectId }[]>();

  await Promise.all(followers.map(async ({ followerId }) => {
    const recipientId = followerId.toString();
    if (await blocked(recipientId, author.userId)) return;
    await deliver(
      recipientId,
      'followed_project',
      { type: 'followed_project', publicId, 'meta.kind': kind },
      {
        $setOnInsert: { sticky: false, body: null, actors: [actorDoc(author)], actorCount: 1 },
        $set: { projectTitle, read: false },
      },
      { fanOut: true },
    ).catch(() => {});
  }));
}

// ─── Progression ─────────────────────────────────────────────────────────────

export async function notifyLevelUp(userId: string, level: number): Promise<void> {
  await deliver(
    userId,
    'level_up',
    { type: 'level_up', 'meta.level': level },
    { $setOnInsert: { sticky: false, body: null, actors: [], actorCount: 0 }, $set: { read: false } },
  );
}

// ─── Playlists and stars ─────────────────────────────────────────────────────

export async function notifyPlaylistSaved(params: { ownerId: string; actor: Actor; playlistId: string; name: string }): Promise<void> {
  const { ownerId, actor, playlistId, name } = params;
  if (ownerId === actor.userId || await blocked(ownerId, actor.userId)) return;
  await deliver(
    ownerId,
    'playlist_saved',
    { type: 'playlist_saved', 'meta.playlistId': playlistId },
    {
      $setOnInsert: { sticky: false, body: null },
      $set: { read: false, projectTitle: name },
      $addToSet: { actors: actorDoc(actor) },
      $inc: { actorCount: 1 },
    },
  );
}

const STAR_MILESTONES = new Set([10, 25, 50, 100, 250, 500, 1000, 5000]);

export async function notifyStarMilestone(params: { ownerId: string; publicId: string; projectTitle: string; count: number }): Promise<void> {
  const { ownerId, publicId, projectTitle, count } = params;
  if (!STAR_MILESTONES.has(count)) return;
  await deliver(
    ownerId,
    'star_milestone',
    { type: 'star_milestone', publicId, 'meta.count': count },
    { $setOnInsert: { sticky: false, body: null, actors: [], actorCount: 0 }, $set: { read: false, projectTitle } },
  );
}

// ─── Account ─────────────────────────────────────────────────────────────────

export async function notifyNewDevice(userId: string, device: { label: string; ip: string | null }): Promise<void> {
  const prefs = await getPreferences(userId);
  if (prefs.notifications.new_device === false) return;
  const notification = await Notification.create({
    userId: oid(userId),
    type: 'new_device',
    sticky: false,
    read: false,
    meta: { label: device.label, ip: device.ip },
  });
  const plain = notification.toObject() as unknown as INotification;
  enqueueNotif(userId, plain);
  emit(userId, plain);
}

export async function notifyAppealResult(userId: string, approved: boolean): Promise<void> {
  const prefs = await getPreferences(userId);
  if (prefs.notifications.appeal_result === false) return;
  const notification = await Notification.create({
    userId: oid(userId),
    type: 'appeal_result',
    sticky: false,
    read: false,
    meta: { approved },
  });
  const plain = notification.toObject() as unknown as INotification;
  enqueueNotif(userId, plain);
  emit(userId, plain);
}

// ─── Profile wall ────────────────────────────────────────────────────────────

/**
 * A comment on `wallOwner`'s wall, told to one recipient. Unread ones for the same wall (and
 * the same kind: a new comment, or a reply to the recipient's own) fold into one notification.
 */
export async function notifyWallComment(params: {
  recipientId: string;
  actor: Actor;
  wallOwnerAccountName: string;
  reply: boolean;
}): Promise<void> {
  const { recipientId, actor, wallOwnerAccountName, reply } = params;
  if (recipientId === actor.userId || await blocked(recipientId, actor.userId)) return;
  await deliver(
    recipientId,
    'wall_comment',
    { type: 'wall_comment', 'meta.wall': wallOwnerAccountName, 'meta.reply': reply },
    {
      $setOnInsert: { sticky: false, body: null },
      $set: { read: false },
      $addToSet: { actors: actorDoc(actor) },
      $inc: { actorCount: 1 },
    },
  );
}
