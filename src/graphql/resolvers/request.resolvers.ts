import { Context } from './context.js';
import User from '../../db/user.model.js';
import type { IUser } from '../../db/user.model.js';
import type { IStaffRequest } from '../../modules/requests/request.model.js';
import {
  createRequest,
  listMyRequests,
  listPendingForReviewer,
  listReviewedByMe,
  getRequestCounts,
  reviewRequest,
  submittableTypes,
  reviewableTypes,
} from '../../modules/requests/request.service.js';

function requireUser(context: Context): string {
  if (!context.userId) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return context.userId;
}

async function loadStaff(userId: string): Promise<{ role: string; permissions: string[]; name: string }> {
  const u = await User.findById(userId).select('role permissions accountName').lean<IUser>();
  return { role: u?.role ?? 'user', permissions: u?.permissions ?? [], name: u?.accountName ?? 'unknown' };
}

function toGql(r: IStaffRequest) {
  return {
    id: (r._id as { toString(): string }).toString(),
    requesterId: r.issuer.id.toString(),
    requesterName: r.issuer.name,
    type: r.type,
    payload: JSON.stringify(r.payload ?? {}),
    summary: r.summary,
    status: r.status,
    reviewerName: r.reviewer?.name ?? null,
    decisionNote: r.decisionNote ?? null,
    error: r.error ?? null,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
  };
}

export const requestResolvers = {
  Query: {
    myRequests: async (_root: unknown, _args: unknown, context: Context) => {
      const userId = requireUser(context);
      return (await listMyRequests(userId)).map(toGql);
    },

    pendingRequests: async (_root: unknown, _args: unknown, context: Context) => {
      const userId = requireUser(context);
      const { permissions } = await loadStaff(userId);
      return (await listPendingForReviewer(permissions)).map(toGql);
    },

    reviewedRequests: async (_root: unknown, _args: unknown, context: Context) => {
      const userId = requireUser(context);
      return (await listReviewedByMe(userId)).map(toGql);
    },

    requestCapabilities: async (_root: unknown, _args: unknown, context: Context) => {
      const userId = requireUser(context);
      const { role, permissions } = await loadStaff(userId);
      return { submittable: submittableTypes(role), reviewable: reviewableTypes(permissions) };
    },

    requestCounts: async (_root: unknown, _args: unknown, context: Context) => {
      const userId = requireUser(context);
      const { permissions } = await loadStaff(userId);
      return getRequestCounts(userId, permissions);
    },
  },

  Mutation: {
    submitRequest: async (_root: unknown, { type, payload }: { type: string; payload: string }, context: Context) => {
      const userId = requireUser(context);
      const { role, name } = await loadStaff(userId);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payload) as Record<string, unknown>; }
      catch { throw Object.assign(new Error('Invalid payload'), { status: 400 }); }
      const doc = await createRequest({ userId, role, name }, type, parsed);
      return toGql(doc);
    },

    reviewRequest: async (_root: unknown, { id, decision, note }: { id: string; decision: string; note?: string }, context: Context) => {
      const userId = requireUser(context);
      const { permissions } = await loadStaff(userId);
      if (decision !== 'approve' && decision !== 'reject') {
        throw Object.assign(new Error('decision must be approve or reject'), { status: 400 });
      }
      const doc = await reviewRequest({ userId, permissions, ip: context.ip }, id, decision, note);
      return toGql(doc);
    },
  },
};
