import mongoose from 'mongoose';
import User from '../users/user.model.js';
import type { IUser } from '../users/user.model.js';
import Project from '../projects/project.model.js';
import type { IProject } from '../projects/project.model.js';
import Playlist from '../playlists/playlist.model.js';
import type { IPlaylist } from '../playlists/playlist.model.js';
import { WallComment, WallRestriction } from '../wall/wall.models.js';
import type { IWallComment, WallCommentStatus } from '../wall/wall.models.js';
import { resolveTags, tagsOf, plainText } from '../wall/wall-mentions.js';
import type { WallMention, WallProjectRef } from '../wall/wall-mentions.js';
import { blockUser, hasBlocked, isHiddenByBlock } from '../blocks/block.service.js';
import { logAdminAction } from '../admin/admin.service.js';
import { hasPermission, rankOf } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import { notifyReport, notifyReportReviewed, type ReportTargetMeta } from '../notifications/notifications.events.js';
import { getIO } from '../../socket/socket.manager.js';
import { deleteProjectAsModerator } from '../projects/projects.crud.service.js';
import { deletePlaylistAsModerator } from '../playlists/playlists.service.js';
import {
  Report, REPORT_TARGET_TYPES, REPORT_STATUSES, REASONS_BY_TYPE, REPORT_NOTE_MAX,
  type IReport, type ReportStatus, type ReportTargetType,
} from './report.model.js';

/**
 * Reports of wall comments, accounts, projects and playlists: filing one, the moderators'
 * queue (one entry per target), the reporter's own history, and settling a target's reports.
 *
 * wall.service imports settleReports from here, so the wall functions this module needs
 * (getComment, deleteComment) are imported lazily to keep the two out of a load-time cycle.
 */
const wallService = () => import('../wall/wall.service.js');

/** The error codes the resolvers pass on; the client maps each to a message. */
export class ReportError extends Error {
  constructor(public code: 'invalid_body' | 'not_found' | 'forbidden' | 'rate_limited' | 'sudo_required') {
    super(code);
  }
}

// Per reporter, across every kind of target: enough for a bad day, not enough to flood the queue.
const REPORT_LIMIT_COUNT = 20;
const REPORT_LIMIT_WINDOW_MS = 60 * 60_000;
// How far back a subject's record looks.
const RECORD_WINDOW_MS = 30 * 24 * 60 * 60_000;
const LABEL_MAX = 80;
const BIO_PREVIEW = 200;

const oid = (id: string | mongoose.Types.ObjectId) => new mongoose.Types.ObjectId(String(id));

type LeanUser = IUser & { _id: mongoose.Types.ObjectId };
type LeanComment = IWallComment & { _id: mongoose.Types.ObjectId };
// The stored metadata carries song fields IProject's type leaves out.
type LeanProject = Omit<IProject, '_id' | 'metadata'> & { _id: mongoose.Types.ObjectId; metadata?: { songName?: string; songArtist?: string } };
type LeanPlaylist = IPlaylist & { _id: mongoose.Types.ObjectId };
type LeanReport = IReport & { _id: mongoose.Types.ObjectId };

export const isTargetType = (t: unknown): t is ReportTargetType => (REPORT_TARGET_TYPES as readonly unknown[]).includes(t);
const isStatus = (s: unknown): s is ReportStatus => (REPORT_STATUSES as readonly unknown[]).includes(s);
const keyOf = (type: string, id: mongoose.Types.ObjectId | string) => `${type}:${id.toString()}`;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ─── Views ───────────────────────────────────────────────────────────────────

/** A person as reports show them (the WallAuthor shape, so the legacy wall types keep working). */
export interface ReportPerson {
  id: string;
  accountName: string;
  displayName: string | null;
  avatarUrl: string | null;
  staffRole: string | null;
  allowsTags: boolean;
}

const personView = (u: LeanUser): ReportPerson => ({
  id: u._id.toString(),
  accountName: u.accountName ?? '',
  displayName: u.displayName ?? null,
  avatarUrl: u.avatarUrl ?? null,
  staffRole: u.role && u.role !== 'user' ? u.role : null,
  allowsTags: true,
});

export interface ReportCommentView {
  id: string;
  body: string;
  mentions: WallMention[];
  projectRefs: WallProjectRef[];
  author: ReportPerson | null;
  createdAt: string;
  status: WallCommentStatus;
}

export interface CommentTarget {
  comment: ReportCommentView;
  /** The comment it answers, for context (moderators only); null for a top-level comment. */
  parent: ReportCommentView | null;
  wallAccountName: string;
}

export interface UserTarget {
  id: string;
  accountName: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string;
  createdAt: string | null;
  banned: boolean;
}

export interface ProjectTarget {
  id: string;
  publicId: string;
  slug: string;
  title: string;
  artist: string | null;
  coverImage: string | null;
  ownerAccountName: string;
  public: boolean;
}

export interface PlaylistTarget {
  id: string;
  name: string;
  coverImage: string | null;
  ownerAccountName: string;
  projectCount: number;
  public: boolean;
}

/** One of these is set, matching the target's type; all null once the target is gone (or hidden). */
export interface TargetPreview {
  comment: CommentTarget | null;
  user: UserTarget | null;
  project: ProjectTarget | null;
  playlist: PlaylistTarget | null;
}

const NO_PREVIEW: TargetPreview = { comment: null, user: null, project: null, playlist: null };

export interface ReportEntryView {
  id: string;
  reason: string;
  note: string;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
  reporter: ReportPerson | null;
}

export interface ReportGroupView extends TargetPreview {
  targetType: ReportTargetType;
  targetId: string;
  /** For a wall comment: the wall's account name (kept even once the comment is gone). */
  wallAccountName: string | null;
  reports: ReportEntryView[];
  /** Open reports on this target, whatever status was listed. */
  openCount: number;
  latestAt: string;
  /** Who is accountable for the target: the author, the account itself, or the owner. */
  subject: ReportPerson | null;
  /** The subject's distinct targets actioned after reports in the last 30 days. */
  subjectActionedCount: number;
  /** The subject's wall-commenting restriction: ISO date, 'forever', or null. */
  subjectRestrictedUntil: string | null;
}

export interface MyReportView extends TargetPreview {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  note: string;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
}

// ─── Moderators ──────────────────────────────────────────────────────────────

async function isModerator(viewerId: string): Promise<boolean> {
  const viewer = await User.findById(viewerId).select('permissions').lean<LeanUser>();
  return !!viewer && hasPermission(viewer.permissions, 'users.ban');
}

export async function requireModerator(viewerId: string): Promise<void> {
  if (!(await isModerator(viewerId))) throw new ReportError('forbidden');
}

/** Moderators (users.ban) who hear about new reports. */
export async function moderatorIds(): Promise<string[]> {
  const mods = await User.find({ permissions: 'users.ban', isDeleted: { $ne: true }, 'ban.active': { $ne: true } })
    .select('_id').limit(200).lean<LeanUser[]>();
  return mods.map(m => m._id.toString());
}

/** Targets with open reports: the count on the moderators' Reports tab. */
export async function openReportCount(): Promise<number> {
  const [row] = await Report.aggregate<{ n: number }>([
    { $match: { status: 'open' } },
    { $group: { _id: { t: '$targetType', id: '$targetId' } } },
    { $count: 'n' },
  ]);
  return row?.n ?? 0;
}

/** Tells moderators watching the dashboard that the queue changed. */
async function emitReportQueue(): Promise<void> {
  const open = await openReportCount();
  try {
    const admins = getIO().to('admin');
    admins.emit('admin:reports', { open });
    // The client released before generic reports listens to this one; keep it for a release.
    admins.emit('admin:wall_reports', { open });
  } catch { /* socket not ready (tests, startup) */ }
}

/**
 * Settles the open reports on these targets without telling anyone (the target went another
 * way, e.g. its author deleted a comment). Returns how many were settled.
 */
export async function settleReports(
  targetType: ReportTargetType,
  targetIds: (string | mongoose.Types.ObjectId)[],
  status: Exclude<ReportStatus, 'open'>,
  by: string,
): Promise<number> {
  if (targetIds.length === 0) return 0;
  const res = await Report.updateMany(
    { targetType, targetId: { $in: targetIds.map(oid) }, status: 'open' },
    { $set: { status, resolvedBy: oid(by), resolvedAt: new Date() } },
  );
  if (res.modifiedCount > 0) emitReportQueue().catch(() => {});
  return res.modifiedCount;
}

// ─── Targets ─────────────────────────────────────────────────────────────────

const findProject = async (id: string): Promise<LeanProject | null> =>
  mongoose.isValidObjectId(id)
    ? Project.findById(id).lean<LeanProject>()
    : Project.findOne({ publicId: id }).lean<LeanProject>();

const projectTitle = (p: LeanProject): string => p.title || p.metadata?.songName || p.publicId;

/** Whether `viewerId` may see someone else's project: public, owner active, no block between them. */
async function projectVisible(viewerId: string, p: LeanProject): Promise<boolean> {
  return p.public === true && p.ownerActive !== false && !(await isHiddenByBlock(viewerId, p.userId));
}

async function playlistVisible(viewerId: string, p: LeanPlaylist): Promise<boolean> {
  return p.isPublic === true && p.ownerActive !== false && !(await isHiddenByBlock(viewerId, p.userId));
}

/** Whether `viewerId` may see an account's profile: not deleted or banned, and it didn't block them. */
async function userVisible(viewerId: string, u: LeanUser): Promise<boolean> {
  return !u.isDeleted && !u.ban?.active && !(await hasBlocked(u._id.toString(), viewerId));
}

async function commentLabel(body: string, viewerId: string | null): Promise<string> {
  return clip(plainText(body, await resolveTags([body], viewerId)), LABEL_MAX);
}

interface ResolvedTarget {
  targetId: mongoose.Types.ObjectId;
  subjectUserId: mongoose.Types.ObjectId | null;
  contextUserId: mongoose.Types.ObjectId | null;
  meta: ReportTargetMeta;
}

/** The target as `viewerId` may see it, for filing a report; throws when they can't report it. */
async function targetForReporter(viewerId: string, targetType: ReportTargetType, rawId: string): Promise<ResolvedTarget> {
  switch (targetType) {
    case 'wall_comment': {
      if (!mongoose.isValidObjectId(rawId)) throw new ReportError('not_found');
      const { getComment } = await wallService();
      const view = await getComment(viewerId, rawId);
      if (!view) throw new ReportError('not_found');
      if (view.author.id === viewerId) throw new ReportError('forbidden');
      const doc = await WallComment.findById(rawId).select('wallUserId authorId body').lean<LeanComment>();
      if (!doc) throw new ReportError('not_found');
      const wallOwner = await User.findById(doc.wallUserId).select('accountName').lean<LeanUser>();
      return {
        targetId: doc._id, subjectUserId: doc.authorId, contextUserId: doc.wallUserId,
        meta: { targetType, targetLabel: await commentLabel(doc.body, viewerId), wall: wallOwner?.accountName ?? '' },
      };
    }
    case 'user': {
      const user = mongoose.isValidObjectId(rawId) ? await User.findById(rawId).select('accountName isDeleted ban').lean<LeanUser>() : null;
      if (!user) throw new ReportError('not_found');
      if (user._id.toString() === viewerId) throw new ReportError('forbidden');
      if (!(await userVisible(viewerId, user))) throw new ReportError('not_found');
      return { targetId: user._id, subjectUserId: user._id, contextUserId: null, meta: { targetType, targetLabel: user.accountName ?? '' } };
    }
    case 'project': {
      const project = await findProject(rawId);
      if (!project) throw new ReportError('not_found');
      if (project.userId?.toString() === viewerId) throw new ReportError('forbidden');
      if (!(await projectVisible(viewerId, project))) throw new ReportError('not_found');
      return {
        targetId: project._id, subjectUserId: project.userId ?? null, contextUserId: null,
        meta: { targetType, targetLabel: clip(projectTitle(project), LABEL_MAX) },
      };
    }
    case 'playlist': {
      const playlist = mongoose.isValidObjectId(rawId) ? await Playlist.findById(rawId).lean<LeanPlaylist>() : null;
      if (!playlist) throw new ReportError('not_found');
      if (playlist.userId.toString() === viewerId) throw new ReportError('forbidden');
      if (!(await playlistVisible(viewerId, playlist))) throw new ReportError('not_found');
      return {
        targetId: playlist._id, subjectUserId: playlist.userId, contextUserId: null,
        meta: { targetType, targetLabel: clip(playlist.name ?? '', LABEL_MAX) },
      };
    }
  }
}

/** A target's label as a moderator sees it ('' once it is gone), for notifications and the audit log. */
async function labelForModerator(targetType: ReportTargetType, targetId: mongoose.Types.ObjectId, contextUserId: mongoose.Types.ObjectId | null, viewerId: string): Promise<ReportTargetMeta> {
  switch (targetType) {
    case 'wall_comment': {
      const [doc, wallOwner] = await Promise.all([
        WallComment.findById(targetId).select('body').lean<LeanComment>(),
        contextUserId ? User.findById(contextUserId).select('accountName').lean<LeanUser>() : null,
      ]);
      return { targetType, targetLabel: doc ? await commentLabel(doc.body, viewerId) : '', wall: wallOwner?.accountName ?? '' };
    }
    case 'user': {
      const user = await User.findById(targetId).select('accountName').lean<LeanUser>();
      return { targetType, targetLabel: user?.accountName ?? '' };
    }
    case 'project': {
      const project = await Project.findById(targetId).lean<LeanProject>();
      return { targetType, targetLabel: project ? clip(projectTitle(project), LABEL_MAX) : '' };
    }
    case 'playlist': {
      const playlist = await Playlist.findById(targetId).select('name').lean<LeanPlaylist>();
      return { targetType, targetLabel: clip(playlist?.name ?? '', LABEL_MAX) };
    }
  }
}

/**
 * Previews of the given targets, keyed by `type:id`. Moderators see every target that still
 * exists; anyone else (`asModerator` false) only what they may still see. Comment previews
 * carry the comment they answer when `withParents` is set.
 */
async function buildPreviews(
  viewerId: string,
  refs: { targetType: ReportTargetType; targetId: mongoose.Types.ObjectId }[],
  { asModerator, withParents = false }: { asModerator: boolean; withParents?: boolean },
): Promise<Map<string, TargetPreview>> {
  const idsOf = (t: ReportTargetType) => [...new Set(refs.filter(r => r.targetType === t).map(r => r.targetId.toString()))];
  const commentIds = idsOf('wall_comment');
  const userIds = idsOf('user');
  const projectIds = idsOf('project');
  const playlistIds = idsOf('playlist');

  const [comments, users, projects, playlists] = await Promise.all([
    commentIds.length ? WallComment.find({ _id: { $in: commentIds } }).lean<LeanComment[]>() : [],
    userIds.length ? User.find({ _id: { $in: userIds } }).select('accountName displayName avatarUrl bio createdAt isDeleted ban role').lean<LeanUser[]>() : [],
    projectIds.length ? Project.find({ _id: { $in: projectIds } }).lean<LeanProject[]>() : [],
    playlistIds.length ? Playlist.find({ _id: { $in: playlistIds } }).lean<LeanPlaylist[]>() : [],
  ]);

  // What a non-moderator may no longer see drops out.
  let shownComments = comments;
  let shownUsers = users;
  let shownProjects = projects;
  let shownPlaylists = playlists;
  if (!asModerator) {
    const { getComment } = await wallService();
    const keep = async <T>(items: T[], ok: (item: T) => Promise<boolean>): Promise<T[]> => {
      const flags = await Promise.all(items.map(ok));
      return items.filter((_, i) => flags[i]);
    };
    [shownComments, shownUsers, shownProjects, shownPlaylists] = await Promise.all([
      keep(comments, async c => !!(await getComment(viewerId, c._id.toString()))),
      keep(users, u => userVisible(viewerId, u)),
      keep(projects, p => projectVisible(viewerId, p)),
      keep(playlists, p => playlistVisible(viewerId, p)),
    ]);
  }

  const parents = withParents && shownComments.length
    ? await WallComment.find({ _id: { $in: shownComments.map(c => c.replyToId ?? c.parentId).filter(Boolean) } }).lean<LeanComment[]>()
    : [];
  const peopleIds = [...new Set([
    ...[...shownComments, ...parents].flatMap(c => [c.authorId.toString(), c.wallUserId.toString()]),
    ...shownProjects.flatMap(p => (p.userId ? [p.userId.toString()] : [])),
    ...shownPlaylists.map(p => p.userId.toString()),
  ])];
  const [people, resolved] = await Promise.all([
    peopleIds.length ? User.find({ _id: { $in: peopleIds } }).select('accountName displayName avatarUrl role').lean<LeanUser[]>() : [],
    resolveTags([...shownComments, ...parents].map(c => c.body), viewerId),
  ]);
  const personById = new Map(people.map(u => [u._id.toString(), u]));
  const person = (id: string) => { const u = personById.get(id); return u ? personView(u) : null; };
  const nameOf = (id: string | null | undefined) => (id ? personById.get(id)?.accountName ?? '' : '');
  const parentById = new Map(parents.map(c => [c._id.toString(), c]));

  const commentView = (c: LeanComment): ReportCommentView => ({
    id: c._id.toString(), body: c.body, ...tagsOf(c.body, resolved), author: person(c.authorId.toString()),
    createdAt: c.createdAt.toISOString(), status: c.status ?? 'visible',
  });

  const out = new Map<string, TargetPreview>();
  for (const c of shownComments) {
    const parent = withParents ? parentById.get((c.replyToId ?? c.parentId)?.toString() ?? '') : undefined;
    out.set(keyOf('wall_comment', c._id), {
      ...NO_PREVIEW,
      comment: { comment: commentView(c), parent: parent ? commentView(parent) : null, wallAccountName: nameOf(c.wallUserId.toString()) },
    });
  }
  for (const u of shownUsers) {
    out.set(keyOf('user', u._id), {
      ...NO_PREVIEW,
      user: {
        id: u._id.toString(), accountName: u.accountName ?? '', displayName: u.displayName ?? null, avatarUrl: u.avatarUrl ?? null,
        bio: clip(u.bio ?? '', BIO_PREVIEW), createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
        // A reporter only gets this far for an account that isn't banned; the flag is for moderators.
        banned: !!u.ban?.active,
      },
    });
  }
  for (const p of shownProjects) {
    out.set(keyOf('project', p._id), {
      ...NO_PREVIEW,
      project: {
        id: p._id.toString(), publicId: p.publicId, slug: p.slug ?? '', title: projectTitle(p),
        artist: p.metadata?.songArtist || null, coverImage: p.coverImage || null,
        ownerAccountName: nameOf(p.userId?.toString()), public: p.public === true,
      },
    });
  }
  for (const p of shownPlaylists) {
    out.set(keyOf('playlist', p._id), {
      ...NO_PREVIEW,
      playlist: {
        id: p._id.toString(), name: p.name ?? '', coverImage: p.coverImage || null,
        ownerAccountName: nameOf(p.userId.toString()), projectCount: p.publicIds?.length ?? 0, public: p.isPublic === true,
      },
    });
  }
  return out;
}

// ─── Filing ──────────────────────────────────────────────────────────────────

export interface FileReportInput {
  targetType: string;
  targetId: string;
  reason: string;
  note?: string | null;
  /** For an account: also block it, in the same step. Ignored for other targets. */
  alsoBlock?: boolean | null;
}

/**
 * Reports something to the moderators. Anyone signed in who can see it, except whoever is
 * accountable for it; reporting the same thing again updates the reason and reopens a settled
 * report. A new (or reopened) report reaches the moderators at once: a notification, and the
 * dashboard's live count.
 */
export async function fileReport(viewerId: string, input: FileReportInput): Promise<boolean> {
  const { targetType, reason } = input;
  if (!isTargetType(targetType)) throw new ReportError('invalid_body');
  if (!(REASONS_BY_TYPE[targetType] as readonly string[]).includes(reason)) throw new ReportError('invalid_body');
  const target = await targetForReporter(viewerId, targetType, String(input.targetId ?? ''));

  const recent = await Report.countDocuments({ reporterId: oid(viewerId), createdAt: { $gte: new Date(Date.now() - REPORT_LIMIT_WINDOW_MS) } });
  if (recent >= REPORT_LIMIT_COUNT) throw new ReportError('rate_limited');

  const note = stripHtml(input.note ?? '').trim().slice(0, REPORT_NOTE_MAX);
  const key = { targetType, targetId: target.targetId, reporterId: oid(viewerId) };
  const previous = await Report.findOne(key).select('status').lean<LeanReport>();
  const write = () => Report.updateOne(
    key,
    {
      // createdAt is reset too, so a reopened report sits at the end of the queue and counts toward the limit.
      $set: { reason, note, status: 'open', resolvedBy: null, resolvedAt: null, createdAt: new Date() },
      $setOnInsert: { ...key, subjectUserId: target.subjectUserId, contextUserId: target.contextUserId },
    },
    { upsert: true, timestamps: false },
  );
  // Two concurrent first reports can both try to insert; the loser updates the winner's row.
  await write().catch((err: unknown) => {
    if ((err as { code?: number }).code === 11000) return write();
    throw err;
  });

  if (targetType === 'user' && input.alsoBlock) await blockUser(viewerId, target.targetId.toString());

  // Updating a report that is still open is not news.
  if (previous?.status !== 'open') {
    const reporter = await User.findById(viewerId).select('accountName avatarUrl').lean<LeanUser>();
    moderatorIds()
      .then(ids => notifyReport({
        moderatorIds: ids,
        actor: { userId: viewerId, accountName: reporter?.accountName ?? '', avatarUrl: reporter?.avatarUrl ?? null },
        target: target.meta,
      }))
      .catch(() => {});
    emitReportQueue().catch(() => {});
  }
  return true;
}

// ─── Moderators' queue ───────────────────────────────────────────────────────

const entryView = (r: LeanReport, person: (id: string) => ReportPerson | null): ReportEntryView => ({
  id: r._id.toString(),
  reason: r.reason,
  note: r.note ?? '',
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
  reporter: person(r.reporterId.toString()),
});

export interface ReportGroupQuery {
  status?: string | null;
  targetType?: string | null;
  limit?: number | null;
}

/**
 * Reports for moderators (users.ban), one entry per target: every report on it with that
 * status, a preview of the target, and the record of whoever is accountable for it. Open ones
 * oldest first, settled ones newest first.
 */
export async function listReportGroups(viewerId: string, { status: rawStatus, targetType, limit }: ReportGroupQuery = {}): Promise<ReportGroupView[]> {
  await requireModerator(viewerId);
  const status = rawStatus ?? 'open';
  if (!isStatus(status)) throw new ReportError('invalid_body');
  if (targetType != null && !isTargetType(targetType)) throw new ReportError('invalid_body');

  const latest = await Report.aggregate<{ _id: { t: ReportTargetType; id: mongoose.Types.ObjectId }; at: Date }>([
    { $match: { status, ...(targetType ? { targetType } : {}) } },
    { $group: { _id: { t: '$targetType', id: '$targetId' }, at: { $max: status === 'open' ? '$createdAt' : { $ifNull: ['$resolvedAt', '$createdAt'] } } } },
    { $sort: { at: status === 'open' ? 1 : -1 } },
    { $limit: Math.min(100, Math.max(1, limit ?? 30)) },
  ]);
  if (latest.length === 0) return [];
  const targets = latest.map(l => ({ targetType: l._id.t, targetId: l._id.id }));

  const [reports, openCounts, previews] = await Promise.all([
    Report.find({ status, $or: targets }).sort({ createdAt: 1 }).lean<LeanReport[]>(),
    Report.aggregate<{ _id: { t: string; id: mongoose.Types.ObjectId }; n: number }>([
      { $match: { status: 'open', $or: targets } },
      { $group: { _id: { t: '$targetType', id: '$targetId' }, n: { $sum: 1 } } },
    ]),
    buildPreviews(viewerId, targets, { asModerator: true, withParents: true }),
  ]);

  const byTarget = new Map<string, LeanReport[]>();
  for (const r of reports) {
    const k = keyOf(r.targetType, r.targetId);
    byTarget.set(k, [...(byTarget.get(k) ?? []), r]);
  }
  const subjectOf = (rs: LeanReport[]) => rs.find(r => r.subjectUserId)?.subjectUserId?.toString() ?? null;
  const contextOf = (rs: LeanReport[]) => rs.find(r => r.contextUserId)?.contextUserId?.toString() ?? null;
  const subjectIds = [...new Set([...byTarget.values()].map(subjectOf).filter((id): id is string => !!id))];
  const contextIds = [...new Set([...byTarget.values()].map(contextOf).filter((id): id is string => !!id))];
  const peopleIds = [...new Set([...reports.map(r => r.reporterId.toString()), ...subjectIds, ...contextIds])];

  const since = new Date(Date.now() - RECORD_WINDOW_MS);
  const [people, actioned, restrictions] = await Promise.all([
    User.find({ _id: { $in: peopleIds } }).select('accountName displayName avatarUrl role').lean<LeanUser[]>(),
    subjectIds.length
      ? Report.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
          { $match: { status: 'actioned', resolvedAt: { $gte: since }, subjectUserId: { $in: subjectIds.map(oid) } } },
          { $group: { _id: '$subjectUserId', n: { $addToSet: { t: '$targetType', id: '$targetId' } } } },
          { $project: { n: { $size: '$n' } } },
        ])
      : [],
    subjectIds.length ? WallRestriction.find({ userId: { $in: subjectIds.map(oid) } }).lean() : [],
  ]);
  const personById = new Map(people.map(u => [u._id.toString(), u]));
  const person = (id: string) => { const u = personById.get(id); return u ? personView(u) : null; };
  const openOf = new Map(openCounts.map(o => [keyOf(o._id.t, o._id.id), o.n]));
  const actionedOf = new Map(actioned.map(a => [a._id.toString(), a.n]));
  const restrictionOf = new Map(restrictions
    .filter(r => !r.until || r.until.getTime() > Date.now())
    .map(r => [r.userId.toString(), r.until?.toISOString() ?? 'forever']));

  return latest.filter(l => byTarget.has(keyOf(l._id.t, l._id.id))).map(l => {
    const k = keyOf(l._id.t, l._id.id);
    const group = byTarget.get(k)!;
    const subjectId = subjectOf(group);
    const contextId = contextOf(group);
    const preview = previews.get(k) ?? NO_PREVIEW;
    return {
      targetType: l._id.t,
      targetId: l._id.id.toString(),
      ...preview,
      wallAccountName: preview.comment?.wallAccountName ?? (contextId ? personById.get(contextId)?.accountName ?? null : null),
      reports: group.map(r => entryView(r, person)),
      openCount: openOf.get(k) ?? 0,
      latestAt: l.at.toISOString(),
      subject: subjectId ? person(subjectId) : null,
      subjectActionedCount: subjectId ? actionedOf.get(subjectId) ?? 0 : 0,
      subjectRestrictedUntil: subjectId ? restrictionOf.get(subjectId) ?? null : null,
    };
  });
}

/**
 * The viewer's own reports, newest first, with what became of each. A reporter learns the
 * outcome, never who else reported it or how many did, and sees the target only while they
 * still may.
 */
export async function listMyReports(
  viewerId: string,
  limit = 50,
  offset = 0,
  targetType?: ReportTargetType,
): Promise<{ reports: MyReportView[]; total: number }> {
  const filter = { reporterId: oid(viewerId), ...(targetType ? { targetType } : {}) };
  const [reports, total] = await Promise.all([
    Report.find(filter).sort({ createdAt: -1 }).skip(Math.max(0, offset)).limit(Math.min(100, Math.max(1, limit))).lean<LeanReport[]>(),
    Report.countDocuments(filter),
  ]);
  const previews = await buildPreviews(viewerId, reports, { asModerator: false });
  return {
    reports: reports.map(r => ({
      id: r._id.toString(),
      targetType: r.targetType,
      targetId: r.targetId.toString(),
      ...(previews.get(keyOf(r.targetType, r.targetId)) ?? NO_PREVIEW),
      reason: r.reason,
      note: r.note ?? '',
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    })),
    total,
  };
}

// ─── Settling ────────────────────────────────────────────────────────────────

export interface ResolveReportInput {
  targetType: string;
  targetId: string;
  action: string;
}

/**
 * Settles every open report on a target. 'dismiss' closes them and leaves the target alone.
 * 'action' acts on it first: a wall comment is deleted; a project or playlist is deleted
 * (this needs a sudo grant, and may not reach content of staff of equal or higher rank); an
 * account is left as it is (the moderator bans or restricts it with the existing tools).
 * Each reporter is told, and the decision goes in the audit log.
 */
export async function resolveReportGroup(
  viewerId: string,
  { targetType, targetId, action }: ResolveReportInput,
  { hasSudo = false, ip = null }: { hasSudo?: boolean; ip?: string | null } = {},
): Promise<boolean> {
  await requireModerator(viewerId);
  if (!isTargetType(targetType) || (action !== 'dismiss' && action !== 'action')) throw new ReportError('invalid_body');
  if (!mongoose.isValidObjectId(targetId)) throw new ReportError('not_found');
  const target = oid(targetId);
  const any = await Report.findOne({ targetType, targetId: target }).select('subjectUserId contextUserId').lean<LeanReport>();
  if (!any) throw new ReportError('not_found');

  // Read before acting: the label goes in the notices and the log, and the target may be deleted.
  const [open, meta, subject] = await Promise.all([
    Report.find({ targetType, targetId: target, status: 'open' }).select('_id reporterId').lean<LeanReport[]>(),
    labelForModerator(targetType, target, any.contextUserId, viewerId),
    any.subjectUserId ? User.findById(any.subjectUserId).select('accountName role').lean<LeanUser>() : null,
  ]);
  const outcome = action === 'action' ? 'actioned' : 'dismissed';

  if (action === 'action') {
    if (targetType === 'wall_comment') {
      const { deleteComment } = await wallService();
      await deleteComment(viewerId, targetId);
    } else if (targetType === 'project' || targetType === 'playlist') {
      const exists = targetType === 'project' ? await Project.exists({ _id: target }) : await Playlist.exists({ _id: target });
      if (exists) {
        if (!hasSudo) throw new ReportError('sudo_required');
        // Like a ban: staff content is only reachable by someone who outranks them.
        if (subject && subject._id.toString() !== viewerId) {
          const me = await User.findById(viewerId).select('role').lean<LeanUser>();
          if (rankOf(subject.role) > 0 && rankOf(subject.role) >= rankOf(me?.role)) throw new ReportError('forbidden');
        }
        if (targetType === 'project') await deleteProjectAsModerator(targetId, viewerId);
        else await deletePlaylistAsModerator(targetId);
      }
    }
    // An account: nothing happens to it here.
  }

  await Report.updateMany(
    { targetType, targetId: target, status: 'open' },
    { $set: { status: outcome, resolvedBy: oid(viewerId), resolvedAt: new Date() } },
  );

  for (const r of open) {
    notifyReportReviewed({ recipientId: r.reporterId.toString(), reportId: r._id.toString(), outcome, target: meta }).catch(() => {});
  }
  await logAdminAction({
    adminId: viewerId,
    action: action === 'action' ? 'report_action' : 'report_dismiss',
    targetId: subject?._id.toString() ?? null,
    targetName: subject?.accountName ?? null,
    details: clip(`${targetType}${meta.targetLabel ? ` "${meta.targetLabel}"` : ''}${meta.wall ? ` on ${meta.wall}'s wall` : ''}: ${open.length} open report(s)`, 300),
    ip,
  }).catch(() => {});
  emitReportQueue().catch(() => {});
  return true;
}
