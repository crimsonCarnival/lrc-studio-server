import mongoose from 'mongoose';
import User from '../users/user.model.js';
import type { IUser } from '../users/user.model.js';
import { Report, type IReport, type ReportStatus } from './report.model.js';
import {
  ReportError, fileReport, listMyReports, listReportGroups, openReportCount, requireModerator, resolveReportGroup,
  type ReportCommentView, type ReportPerson,
} from './reports.service.js';

/**
 * The wall-only report API the client used before generic reports (reportWallComment,
 * wallReports, wallReportGroups, wallOpenReportCount, myWallReports, resolveWallReport), kept
 * in the old shapes on top of the generic service until the new client is out. Delete this
 * file together with those GraphQL fields.
 */

type LeanReport = IReport & { _id: mongoose.Types.ObjectId };
type LeanUser = IUser & { _id: mongoose.Types.ObjectId };

export interface WallReportView {
  id: string;
  reason: string;
  note: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  openCount: number;
  reporter: ReportPerson | null;
  wallAccountName: string;
  comment: ReportCommentView | null;
}

export interface WallReportGroupView {
  commentId: string;
  wallAccountName: string;
  comment: ReportCommentView | null;
  parent: ReportCommentView | null;
  reports: WallReportView[];
  openCount: number;
  latestAt: string;
  authorActionedCount: number;
  authorRestrictedUntil: string | null;
}

export function reportWallComment(viewerId: string, commentId: string, reason: string, note: string | null | undefined): Promise<boolean> {
  return fileReport(viewerId, { targetType: 'wall_comment', targetId: commentId, reason, note });
}

export async function listWallReportGroups(viewerId: string, status: ReportStatus = 'open', limit = 30): Promise<WallReportGroupView[]> {
  const groups = await listReportGroups(viewerId, { status, targetType: 'wall_comment', limit });
  return groups.map(g => {
    const wallAccountName = g.wallAccountName ?? '';
    const comment = g.comment?.comment ?? null;
    return {
      commentId: g.targetId,
      wallAccountName,
      comment,
      parent: g.comment?.parent ?? null,
      reports: g.reports.map(r => ({ ...r, openCount: g.openCount, wallAccountName, comment })),
      openCount: g.openCount,
      latestAt: g.latestAt,
      authorActionedCount: g.subjectActionedCount,
      authorRestrictedUntil: g.subjectRestrictedUntil,
    };
  });
}

/** Single reports, oldest open first; each carries its comment's group data. */
export async function listWallReports(viewerId: string, status: ReportStatus = 'open', limit = 50): Promise<WallReportView[]> {
  const groups = await listWallReportGroups(viewerId, status, Math.min(100, Math.max(1, limit)));
  const all = groups.flatMap(g => g.reports);
  all.sort((a, b) => (status === 'open' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt));
  return all.slice(0, Math.min(100, Math.max(1, limit)));
}

export async function wallOpenReportCount(viewerId: string): Promise<number> {
  await requireModerator(viewerId);
  return openReportCount();
}

export async function listMyWallReports(viewerId: string, limit = 50, offset = 0): Promise<{ reports: WallReportView[]; total: number }> {
  const { reports, total } = await listMyReports(viewerId, limit, offset, 'wall_comment');
  // The wall's name stays on the row once the comment is gone.
  const raw = await Report.find({ _id: { $in: reports.map(r => r.id) } }).select('contextUserId').lean<LeanReport[]>();
  const owners = await User.find({ _id: { $in: raw.map(r => r.contextUserId).filter(Boolean) } }).select('accountName').lean<LeanUser[]>();
  const nameById = new Map(owners.map(o => [o._id.toString(), o.accountName ?? '']));
  const ownerOf = new Map(raw.map(r => [r._id.toString(), r.contextUserId ? nameById.get(r.contextUserId.toString()) ?? '' : '']));
  return {
    reports: reports.map(r => ({
      id: r.id, reason: r.reason, note: r.note, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
      openCount: 0, reporter: null,
      wallAccountName: r.comment?.wallAccountName ?? ownerOf.get(r.id) ?? '',
      comment: r.comment?.comment ?? null,
    })),
    total,
  };
}

/** 'delete' removes the comment and settles every open report on it; 'dismiss' just settles them. */
export async function resolveWallReport(viewerId: string, reportId: string, action: 'dismiss' | 'delete', ip?: string | null): Promise<boolean> {
  await requireModerator(viewerId);
  if (action !== 'dismiss' && action !== 'delete') throw new ReportError('invalid_body');
  const report = mongoose.isValidObjectId(reportId)
    ? await Report.findOne({ _id: reportId, targetType: 'wall_comment' }).select('targetId').lean<LeanReport>()
    : null;
  if (!report) throw new ReportError('not_found');
  return resolveReportGroup(
    viewerId,
    { targetType: 'wall_comment', targetId: report.targetId.toString(), action: action === 'delete' ? 'action' : 'dismiss' },
    { ip: ip ?? null },
  );
}
