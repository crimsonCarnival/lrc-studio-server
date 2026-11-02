import mongoose from 'mongoose';
import User, { type IUser } from '../users/user.model.js';
import { hasPermission } from '../../shared/permissions.js';
import { stripHtml } from '../../utils/sanitize.js';
import { notifyReportMessage } from '../notifications/notifications.events.js';
import { Report, type IReport } from './report.model.js';
import { ReportMessage, REPORT_MESSAGE_MAX, type IReportMessage } from './report-message.model.js';
import { ReportError, type ReportPerson } from './reports.service.js';

/**
 * A report's conversation: the reporter and the moderators (users.ban) can read and write
 * it; nobody else can see it exists. To the reporter, moderators are anonymous ("Moderator",
 * no name or avatar), so a decision can't be pinned on one person; moderators see names.
 * Threads stay open after the report is settled, so a reporter can still ask about it.
 */

// One level of replies, like the wall: a reply to a reply joins the same thread.
const MAX_MESSAGES_PER_REPORT = 100;
const RATE_LIMIT_COUNT = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

type LeanUser = IUser & { _id: mongoose.Types.ObjectId };
type LeanReport = IReport & { _id: mongoose.Types.ObjectId };
type LeanMessage = IReportMessage & { _id: mongoose.Types.ObjectId };

export interface ReportMessageView {
  id: string;
  body: string;
  createdAt: string;
  /** Null when the viewer may not see who wrote it (a moderator, seen by the reporter), or the author is gone. */
  author: ReportPerson | null;
  fromReporter: boolean;
  /** The viewer wrote it. */
  mine: boolean;
  replies: ReportMessageView[];
}

interface Access {
  report: LeanReport;
  isModerator: boolean;
}

/** The report, if `viewerId` may take part in its conversation; not_found otherwise, so ids can't be probed. */
async function access(viewerId: string, reportId: string): Promise<Access> {
  if (!mongoose.isValidObjectId(reportId)) throw new ReportError('not_found');
  const [report, viewer] = await Promise.all([
    Report.findById(reportId).lean<LeanReport>(),
    User.findById(viewerId).select('permissions').lean<LeanUser>(),
  ]);
  if (!report) throw new ReportError('not_found');
  const isModerator = !!viewer && hasPermission(viewer.permissions, 'users.ban');
  if (!isModerator && report.reporterId.toString() !== viewerId) throw new ReportError('not_found');
  return { report, isModerator };
}

async function buildViews(viewerId: string, isModerator: boolean, messages: LeanMessage[]): Promise<ReportMessageView[]> {
  const authorIds = [...new Set(messages.map(m => m.authorId.toString()))];
  const authors = await User.find({ _id: { $in: authorIds }, isDeleted: { $ne: true } })
    .select('accountName displayName avatarUrl role')
    .lean<LeanUser[]>();
  const byId = new Map(authors.map(a => [a._id.toString(), a]));

  const view = (m: LeanMessage): ReportMessageView => {
    const author = byId.get(m.authorId.toString());
    const mine = m.authorId.toString() === viewerId;
    const visible = author && (isModerator || m.fromReporter || mine);
    return {
      id: m._id.toString(),
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      author: visible ? {
        id: author._id.toString(),
        accountName: author.accountName ?? '',
        displayName: author.displayName ?? null,
        avatarUrl: author.avatarUrl ?? null,
        staffRole: author.role && author.role !== 'user' ? author.role : null,
        allowsTags: false,
      } : null,
      fromReporter: m.fromReporter,
      mine,
      replies: [],
    };
  };

  const roots: ReportMessageView[] = [];
  const rootById = new Map<string, ReportMessageView>();
  for (const m of messages.filter(m => !m.parentId)) {
    const v = view(m);
    roots.push(v);
    rootById.set(v.id, v);
  }
  for (const m of messages.filter(m => m.parentId)) {
    rootById.get(m.parentId!.toString())?.replies.push(view(m));
  }
  return roots;
}

/** A report's conversation, oldest first, replies under the message they answer. */
export async function listReportMessages(viewerId: string, reportId: string): Promise<ReportMessageView[]> {
  const { report, isModerator } = await access(viewerId, reportId);
  const messages = await ReportMessage.find({ reportId: report._id }).sort({ createdAt: 1 }).lean<LeanMessage[]>();
  return buildViews(viewerId, isModerator, messages);
}

/**
 * Adds a message (or, with `parentId`, a reply) to a report's conversation.
 *
 * Who hears about it: a reply tells the author of the message it answers. Otherwise a
 * moderator's message tells the reporter, and the reporter's message tells the moderators
 * who have already written in this conversation (the queue shows the rest).
 */
export async function addReportMessage(viewerId: string, reportId: string, rawBody: string, parentId?: string | null): Promise<ReportMessageView> {
  const { report, isModerator } = await access(viewerId, reportId);
  const body = stripHtml(rawBody ?? '').trim();
  if (body.length < 1 || body.length > REPORT_MESSAGE_MAX) throw new ReportError('invalid_body');

  let parent: LeanMessage | null = null;
  if (parentId) {
    if (!mongoose.isValidObjectId(parentId)) throw new ReportError('not_found');
    parent = await ReportMessage.findOne({ _id: parentId, reportId: report._id }).lean<LeanMessage>();
    if (!parent) throw new ReportError('not_found');
  }

  const authorId = new mongoose.Types.ObjectId(viewerId);
  const [inThread, recent] = await Promise.all([
    ReportMessage.countDocuments({ reportId: report._id }),
    ReportMessage.countDocuments({ authorId, createdAt: { $gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) } }),
  ]);
  if (inThread >= MAX_MESSAGES_PER_REPORT || recent >= RATE_LIMIT_COUNT) throw new ReportError('rate_limited');

  const fromReporter = report.reporterId.toString() === viewerId;
  const created = await ReportMessage.create({
    reportId: report._id,
    authorId,
    fromReporter,
    parentId: parent ? (parent.parentId ?? parent._id) : null,
    body,
  });

  void tell({ report, viewerId, fromReporter, parent, messageId: created._id.toString() }).catch(() => {});

  // Built on its own, a reply has no parent in the list to sit under, so it is viewed as a root.
  const [view] = await buildViews(viewerId, isModerator, [{ ...(created.toObject() as LeanMessage), parentId: null }]);
  return view;
}

async function tell({ report, viewerId, fromReporter, parent, messageId }: {
  report: LeanReport;
  viewerId: string;
  fromReporter: boolean;
  parent: LeanMessage | null;
  messageId: string;
}): Promise<void> {
  const reporterId = report.reporterId.toString();
  const recipients = new Set<string>();
  if (parent) {
    recipients.add(parent.authorId.toString());
  } else if (!fromReporter) {
    recipients.add(reporterId);
  } else {
    const mods = await ReportMessage.distinct('authorId', { reportId: report._id, fromReporter: false });
    for (const id of mods) recipients.add(String(id));
  }
  recipients.delete(viewerId);
  if (recipients.size === 0) return;

  const author = await User.findById(viewerId).select('accountName avatarUrl').lean<LeanUser>();
  await Promise.all([...recipients].map(recipientId => notifyReportMessage({
    recipientId,
    reportId: report._id.toString(),
    messageId,
    // The reporter never learns which moderator wrote; moderators see who did.
    actor: fromReporter || recipientId !== reporterId
      ? { userId: viewerId, accountName: author?.accountName ?? '', avatarUrl: author?.avatarUrl ?? null }
      : null,
    toReporter: recipientId === reporterId,
  }).catch(() => {})));
}

/** How many messages each report has, for the badges on the lists. */
export async function messageCounts(reportIds: string[]): Promise<Map<string, number>> {
  const ids = reportIds.filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return new Map();
  const rows = await ReportMessage.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
    { $match: { reportId: { $in: ids } } },
    { $group: { _id: '$reportId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(r => [r._id.toString(), r.n]));
}
