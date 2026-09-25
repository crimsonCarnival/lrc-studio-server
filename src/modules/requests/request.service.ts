import mongoose from 'mongoose';
import StaffRequest, { type IStaffRequest, type RequestType, REQUEST_TYPES } from './request.model.js';
import User from '../../db/user.model.js';
import type { IUser } from '../../db/user.model.js';
import { hasPermission, type Permission } from '../../shared/permissions.js';
import * as adminService from '../admin/admin.service.js';
import { createBadgeDef, updateBadgeDef, deleteBadgeDef } from '../badges/badge.service.js';
import { createLevel, updateLevel, deleteLevel } from '../stats/addiction-level.service.js';
import { notifyRequestSubmitted, notifyRequestReviewed } from '../notifications/notifications.service.js';
import { enqueueRequest, removeRequest, getPendingRequests } from './request.queue.js';
import { sanitizePayload, MAX_NOTE_CHARS, type Payload } from './request.payload.js';

interface Reviewer { userId: string; ip?: string }

interface RequestSpec {
  reviewerPerm: Permission;        // permission needed to review (and to execute)
  requiresSudo?: boolean;          // true when the direct REST route has requireSudo
  summarize: (p: Payload) => string;
  execute: (p: Payload, reviewer: Reviewer) => Promise<void>;
}

const httpError = (message: string, status: number): Error => Object.assign(new Error(message), { status });

// Badge/level services don't audit-log themselves (the direct GraphQL resolvers
// do), so executors log with the reviewer as actor, matching those resolvers.
function audit(r: Reviewer, action: string, targetName: string, details?: string | null): void {
  adminService.logAdminAction({ adminId: r.userId, action, targetName, details: details ?? 'via staff request', ip: r.ip }).catch(() => {});
}

const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Maps each request type to who may submit/review it and how an approval is
// executed. The executor runs the real action with the reviewer as the actor,
// so existing audit logging + side effects apply unchanged.
const SPEC: Record<RequestType, RequestSpec> = {
  block_ip: {
    reviewerPerm: 'network.block', requiresSudo: true, // POST /admin/banned-ips
    summarize: p => `Block IP ${str(p.ip)}${p.reason ? ` — ${str(p.reason)}` : ''}`,
    execute: async (p, r) => {
      const res = await adminService.blockIp(str(p.ip), str(p.reason), r.userId, r.ip);
      if (res.error) throw new Error(String(res.error));
    },
  },
  block_device: {
    reviewerPerm: 'network.block', requiresSudo: true, // POST /admin/banned-devices
    summarize: p => `Block device ${str(p.deviceId)}${p.reason ? ` — ${str(p.reason)}` : ''}`,
    execute: async (p, r) => {
      const res = await adminService.blockDevice(str(p.deviceId), str(p.reason), r.userId, r.ip);
      if (res.error) throw new Error(String(res.error));
    },
  },
  xp_adjust: {
    reviewerPerm: 'xp.adjust', requiresSudo: true, // POST /admin/xp
    summarize: p => `${str(p.action)} ${num(p.amount)} XP → ${p.target === 'all' ? 'all users' : str(p.userId) || `${(p.userIds as unknown[] | undefined)?.length ?? 0} users`}`,
    execute: async (p, r) => {
      await adminService.adjustXP(
        p.action === 'revoke' ? 'revoke' : 'grant',
        num(p.amount),
        (p.target as adminService.XPTarget) ?? 'user',
        r.userId,
        p.userId ? str(p.userId) : undefined,
        p.userIds as string[] | undefined,
        r.ip
      );
    },
  },
  badge_create: {
    reviewerPerm: 'badges.manage',
    summarize: p => `Create badge "${str((p.input as { label?: { en?: string } })?.label?.en) || '?'}"`,
    execute: async (p, r) => {
      const def = await createBadgeDef(p.input as Parameters<typeof createBadgeDef>[0], r.userId);
      audit(r, 'create_badge', String(def.id ?? ''));
    },
  },
  badge_update: {
    reviewerPerm: 'badges.manage',
    summarize: p => `Update badge "${str(p.id)}"`,
    execute: async (p, r) => {
      await updateBadgeDef(str(p.id), p.input as Parameters<typeof updateBadgeDef>[1]);
      audit(r, 'update_badge', str(p.id));
    },
  },
  badge_delete: {
    reviewerPerm: 'badges.manage',
    summarize: p => `Delete badge "${str(p.id)}"`,
    execute: async (p, r) => {
      await deleteBadgeDef(str(p.id));
      audit(r, 'delete_badge', str(p.id));
    },
  },
  level_create: {
    reviewerPerm: 'levels.manage',
    summarize: p => `Create level "${str((p.input as { title?: { en?: string } })?.title?.en) || '?'}"`,
    execute: async (p, r) => {
      const level = await createLevel(p.input as Parameters<typeof createLevel>[0]);
      audit(r, 'create_level', level.id);
    },
  },
  level_update: {
    reviewerPerm: 'levels.manage',
    summarize: p => `Update level "${str(p.id)}"`,
    execute: async (p, r) => {
      const level = await updateLevel(str(p.id), p.input as Parameters<typeof updateLevel>[1]);
      if (!level) throw httpError('Level not found', 404);
      audit(r, 'update_level', str(p.id));
    },
  },
  level_delete: {
    reviewerPerm: 'levels.manage',
    summarize: p => `Delete level "${str(p.id)}"`,
    execute: async (p, r) => {
      if (!(await deleteLevel(str(p.id)))) throw httpError('Level not found', 404);
      audit(r, 'delete_level', str(p.id));
    },
  },
};

export function isRequestType(t: string): t is RequestType {
  return (REQUEST_TYPES as readonly string[]).includes(t);
}

/**
 * Request types the given permission set may submit: any staff member (holds at
 * least one permission) can propose an action they cannot perform directly.
 * Permission-based on purpose — `role` never grants access.
 */
export function submittableTypes(permissions: string[]): RequestType[] {
  if (permissions.length === 0) return [];
  return REQUEST_TYPES.filter(t => !hasPermission(permissions, SPEC[t].reviewerPerm));
}

/** Request types the given permission set is allowed to review. */
export function reviewableTypes(permissions: string[]): RequestType[] {
  return REQUEST_TYPES.filter(t => hasPermission(permissions, SPEC[t].reviewerPerm));
}

export async function createRequest(
  requester: { userId: string; permissions: string[]; name: string; ip?: string },
  type: string,
  rawPayload: unknown
): Promise<IStaffRequest> {
  if (!isRequestType(type)) throw httpError('Invalid request type', 400);
  if (requester.permissions.length === 0) throw httpError('Forbidden', 403);
  if (!submittableTypes(requester.permissions).includes(type)) {
    // Holders of the permission act directly; proposals are only for those without it.
    throw httpError('You cannot submit this request', 403);
  }
  const spec = SPEC[type];
  const payload = sanitizePayload(type, rawPayload);

  const doc = await StaffRequest.create({
    issuer: { id: new mongoose.Types.ObjectId(requester.userId), name: requester.name },
    type,
    payload,
    summary: spec.summarize(payload),
    status: 'pending',
  });

  enqueueRequest(doc);
  adminService.logAdminAction({
    adminId: requester.userId, adminName: requester.name, action: 'submit_request',
    targetName: type, details: doc.summary, ip: requester.ip,
  }).catch(() => {});

  // Notify everyone who can review this type (holds the reviewer permission).
  const reviewers = await User.find({
    isDeleted: { $ne: true },
    permissions: spec.reviewerPerm,
    _id: { $ne: doc.issuer.id },
  }).select('_id').lean<{ _id: mongoose.Types.ObjectId }[]>();
  for (const r of reviewers) {
    notifyRequestSubmitted(r._id.toString(), doc._id.toString(), doc.summary).catch(() => {});
  }

  return doc;
}

export async function listMyRequests(userId: string): Promise<IStaffRequest[]> {
  return StaffRequest.find({ 'issuer.id': new mongoose.Types.ObjectId(userId) })
    .sort({ createdAt: -1 }).limit(100).lean<IStaffRequest[]>();
}

export async function listPendingForReviewer(permissions: string[]): Promise<IStaffRequest[]> {
  const types = reviewableTypes(permissions);
  if (types.length === 0) return [];
  const typeSet = new Set<string>(types);
  // Use the in-memory PQ for priority ordering; filter by reviewable types in-memory.
  const ordered = getPendingRequests().filter(r => typeSet.has(r.type));
  // Cap at 200 to match previous DB query behaviour.
  return ordered.slice(0, 200);
}

/** Returns all pending requests in priority order for admin callers (no type filter). */
export function getOrderedPendingRequests(): IStaffRequest[] {
  return getPendingRequests();
}

/** Requests this reviewer has already approved/rejected — their decision history. */
export async function listReviewedByMe(userId: string): Promise<IStaffRequest[]> {
  return StaffRequest.find({
    'reviewer.id': new mongoose.Types.ObjectId(userId),
    status: { $in: ['approved', 'rejected'] },
  }).sort({ resolvedAt: -1 }).limit(100).lean<IStaffRequest[]>();
}

/** Counts for the menu badge: requests awaiting this user's review + their own pending. */
export async function getRequestCounts(
  userId: string,
  permissions: string[]
): Promise<{ pendingReview: number; myPending: number }> {
  const types = reviewableTypes(permissions);
  const userObjId = new mongoose.Types.ObjectId(userId);
  const [pendingReview, myPending] = await Promise.all([
    types.length === 0
      ? Promise.resolve(0)
      : StaffRequest.countDocuments({ status: 'pending', type: { $in: types }, 'issuer.id': { $ne: userObjId } }),
    StaffRequest.countDocuments({ status: 'pending', 'issuer.id': userObjId }),
  ]);
  return { pendingReview, myPending };
}

export async function reviewRequest(
  reviewer: { userId: string; permissions: string[]; ip?: string; hasSudo?: boolean },
  requestId: string,
  decision: 'approve' | 'reject',
  note?: string
): Promise<IStaffRequest> {
  if (!mongoose.isValidObjectId(requestId)) throw httpError('Request not found', 404);
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  if (trimmedNote.length > MAX_NOTE_CHARS) throw httpError(`Note exceeds ${MAX_NOTE_CHARS} characters`, 400);

  const req = await StaffRequest.findById(requestId).lean<IStaffRequest>();
  if (!req) throw httpError('Request not found', 404);
  if (req.status !== 'pending') throw httpError('Request already resolved', 409);

  const spec = SPEC[req.type];
  // `permissions` is loaded from the DB by the caller on every call, so a
  // reviewer whose permission was revoked after submission is refused here.
  if (!hasPermission(reviewer.permissions, spec.reviewerPerm)) throw httpError('You cannot review this request', 403);
  if (req.issuer.id.toString() === reviewer.userId) throw httpError('You cannot review your own request', 403);
  // Approving executes the action, so it needs the same step-up as the direct
  // route. Rejecting executes nothing and needs no sudo.
  if (decision === 'approve' && spec.requiresSudo && !reviewer.hasSudo) {
    throw Object.assign(httpError('sudo_required', 403), { code: 'SUDO_REQUIRED' });
  }

  // Re-validate the stored payload with the same rules used at submission, so a
  // row written before validation existed (or edited in the DB) can't execute.
  let payload: Payload | null = null;
  if (decision === 'approve') {
    try {
      payload = sanitizePayload(req.type, req.payload);
    } catch (err) {
      await StaffRequest.updateOne({ _id: req._id, status: 'pending' }, { $set: { error: (err as Error).message } });
      throw err;
    }
  }

  const me = await User.findById(reviewer.userId).select('accountName').lean<IUser>();
  const reviewerName = me?.accountName ?? 'System';
  const reviewerRef = { id: new mongoose.Types.ObjectId(reviewer.userId), name: reviewerName };

  // Atomic claim: only one reviewer can move a request out of `pending`, so two
  // concurrent approvals can't both execute the action.
  const claimed = await StaffRequest.findOneAndUpdate(
    { _id: req._id, status: 'pending' },
    { $set: {
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewer: reviewerRef,
      decisionNote: trimmedNote || null,
      resolvedAt: new Date(),
      error: null,
    } },
    { new: true }
  );
  if (!claimed) throw httpError('Request already resolved', 409);

  if (payload) {
    try {
      await spec.execute(payload, { userId: reviewer.userId, ip: reviewer.ip });
    } catch (err) {
      // Release the claim so it can be retried after the cause is fixed.
      const message = (err as Error)?.message ?? 'Execution failed';
      await StaffRequest.updateOne(
        { _id: claimed._id, status: 'approved' },
        { $set: { status: 'pending', reviewer: { id: null, name: null }, decisionNote: null, resolvedAt: null, error: message } }
      );
      throw err;
    }
  }

  removeRequest(claimed._id.toString());

  adminService.logAdminAction({
    adminId: reviewer.userId,
    adminName: reviewerName,
    action: decision === 'approve' ? 'approve_request' : 'reject_request',
    targetId: claimed.issuer.id.toString(),
    targetName: claimed.issuer.name,
    details: trimmedNote ? `${claimed.summary} — ${trimmedNote}` : claimed.summary,
    ip: reviewer.ip,
  }).catch(() => {});

  notifyRequestReviewed(claimed.issuer.id.toString(), claimed._id.toString(), claimed.summary, decision === 'approve').catch(() => {});
  return claimed;
}
