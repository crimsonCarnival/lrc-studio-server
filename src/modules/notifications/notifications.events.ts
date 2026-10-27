import mongoose from 'mongoose';
import Notification, { type INotification, type NotificationType } from './notification.model.js';
import Follow from '../users/follow.model.js';
import { getIO } from '../../socket/socket.manager.js';
import { enqueueNotif, enqueueNotifIfLoaded } from '../../lib/notification-heap.js';
import { getPreferences } from '../user-preferences/user-preferences.service.js';
import { getCachedBlockedSet } from '../blocks/block-list.cache.js';
import type { INotificationPrefs } from '../user-preferences/user-preferences.model.js';

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

/** The `match` a folded notification is found by, as one string (keys sorted, so order never matters). */
function dedupeKeyOf(match: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(match).sort().map((k) => [k, match[k]]));
}

/**
 * Creates the recipient's notification, or folds this event into the unread one that already
 * matches `match` (more actors, bumped count). `match` also supplies the new document's
 * type and meta, so it must not be set again in `update`.
 */
async function deliver(
  recipientId: string,
  pref: PrefKey | null,
  match: Record<string, unknown>,
  update: Record<string, unknown>,
  { fanOut = false }: { fanOut?: boolean } = {},
): Promise<boolean> {
  // A null pref is a notice the recipient can't switch off (a sanction on their account).
  if (pref && (await getPreferences(recipientId)).notifications[pref] === false) return false;
  const filter = { userId: oid(recipientId), ...match, read: false };
  const withKey = { ...update, $setOnInsert: { ...(update.$setOnInsert as object | undefined), dedupeKey: dedupeKeyOf(match) } };
  const upsert = () => Notification.findOneAndUpdate(filter, withKey, { upsert: true, returnDocument: 'after' });
  // Two concurrent upserts can both miss and both insert; the unique index on
  // (userId, dedupeKey) rejects the second, and the retry folds into the winner.
  const doc = await upsert().catch((err: unknown) => {
    if ((err as { code?: number }).code === 11000) return upsert();
    throw err;
  });
  const plain = doc.toObject() as unknown as INotification;
  // A batch only touches heaps that are already loaded; offline users read from the DB.
  if (fanOut) enqueueNotifIfLoaded(recipientId, plain);
  else enqueueNotif(recipientId, plain);
  emit(recipientId, plain);
  return true;
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
  /** The newest comment folded in; the notification links straight to it. */
  commentId?: string;
}): Promise<void> {
  const { recipientId, actor, wallOwnerAccountName, reply, commentId } = params;
  if (recipientId === actor.userId || await blocked(recipientId, actor.userId)) return;
  await deliver(
    recipientId,
    'wall_comment',
    { type: 'wall_comment', 'meta.wall': wallOwnerAccountName, 'meta.reply': reply },
    {
      $setOnInsert: { sticky: false, body: null },
      $set: { read: false, ...(commentId ? { 'meta.commentId': commentId } : {}) },
      $addToSet: { actors: actorDoc(actor) },
      $inc: { actorCount: 1 },
    },
  );
}

/**
 * `actor` liked `recipientId`'s comment on `wallOwner`'s wall. Unread likes on the same comment
 * fold into one notification ("ann and 3 others liked your comment").
 */
export async function notifyCommentLike(params: {
  recipientId: string;
  actor: Actor;
  wallOwnerAccountName: string;
  commentId: string;
}): Promise<void> {
  const { recipientId, actor, wallOwnerAccountName, commentId } = params;
  if (recipientId === actor.userId || await blocked(recipientId, actor.userId)) return;
  await deliver(
    recipientId,
    'comment_like',
    { type: 'comment_like', 'meta.commentId': commentId },
    {
      $setOnInsert: { sticky: false, body: null },
      $set: { read: false, 'meta.wall': wallOwnerAccountName },
      $addToSet: { actors: actorDoc(actor) },
      $inc: { actorCount: 1 },
    },
  );
}

/**
 * `actor` tagged `recipientId` in a comment on `wallOwner`'s wall. Unread tags on the same
 * wall fold into one notification. Returns whether one was delivered (false when the
 * recipient turned mentions off, or is in a block relationship with the actor).
 */
export async function notifyMention(params: {
  recipientId: string;
  actor: Actor;
  wallOwnerAccountName: string;
  /** The comment the tag is in; the notification links straight to it. */
  commentId?: string;
}): Promise<boolean> {
  const { recipientId, actor, wallOwnerAccountName, commentId } = params;
  if (recipientId === actor.userId || await blocked(recipientId, actor.userId)) return false;
  return deliver(
    recipientId,
    'mention',
    { type: 'mention', 'meta.wall': wallOwnerAccountName },
    {
      $setOnInsert: { sticky: false, body: null },
      $set: { read: false, ...(commentId ? { 'meta.commentId': commentId } : {}) },
      $addToSet: { actors: actorDoc(actor) },
      $inc: { actorCount: 1 },
    },
  );
}

// ─── Reports ─────────────────────────────────────────────────────────────────
// The wall_report / wall_report_reviewed types are no longer sent; old rows still render.

/** What a report notification says about its target. */
export interface ReportTargetMeta {
  targetType: 'wall_comment' | 'user' | 'project' | 'playlist';
  /** A short human label: the account name, project title, playlist name, or comment excerpt. */
  targetLabel: string;
  /** For a wall comment: the account name of the wall it is on. */
  wall?: string;
}

/**
 * Someone reported something: every moderator (users.ban) but the reporter hears it. Unread
 * ones fold into one notification per moderator ("ann and 2 others reported …"); its meta
 * describes the latest report.
 */
export async function notifyReport(params: { moderatorIds: string[]; actor: Actor; target: ReportTargetMeta }): Promise<void> {
  const { moderatorIds, actor, target } = params;
  const meta = { targetType: target.targetType, targetLabel: target.targetLabel, ...(target.wall !== undefined ? { wall: target.wall } : {}) };
  await Promise.all(moderatorIds.filter(id => id !== actor.userId).map(id => deliver(
    id,
    'report',
    { type: 'report' },
    {
      $setOnInsert: { sticky: false, body: null },
      // The whole meta is replaced, so a folded notification never mixes two targets' fields.
      $set: { read: false, meta },
      $addToSet: { actors: actorDoc(actor) },
      $inc: { actorCount: 1 },
    },
    { fanOut: true },
  ).catch(() => false)));
}

/** A moderator settled `recipientId`'s report: they acted on the target, or dismissed it. */
export async function notifyReportReviewed(params: {
  recipientId: string;
  reportId: string;
  outcome: 'dismissed' | 'actioned';
  target: ReportTargetMeta;
}): Promise<void> {
  const { recipientId, reportId, outcome, target } = params;
  await deliver(
    recipientId,
    'report_reviewed',
    { type: 'report_reviewed', 'meta.reportId': reportId },
    {
      $setOnInsert: { sticky: false, body: null, actors: [], actorCount: 0 },
      $set: {
        read: false,
        'meta.outcome': outcome,
        'meta.targetType': target.targetType,
        'meta.targetLabel': target.targetLabel,
        ...(target.wall !== undefined ? { 'meta.wall': target.wall } : {}),
      },
    },
  );
}

/** A moderator stopped `recipientId` from commenting on walls, until `until` (null: until lifted). */
export async function notifyWallRestricted(params: { recipientId: string; until: Date | null; reason: string }): Promise<void> {
  const { recipientId, until, reason } = params;
  await deliver(
    recipientId,
    null,
    { type: 'wall_restricted', 'meta.until': until?.toISOString() ?? null },
    {
      $setOnInsert: { sticky: false, actors: [], actorCount: 0 },
      $set: { read: false, body: reason || null },
    },
  );
}
