import mongoose from 'mongoose';
import StaffRequest, { type IStaffRequest, type RequestType, REQUEST_TYPES } from './request.model.js';
import User from '../../db/user.model.js';
import type { IUser } from '../../db/user.model.js';
import { hasPermission, WILDCARD, type Permission, type Role } from '../../shared/permissions.js';
import * as adminService from '../admin/admin.service.js';
import { createBadgeDef, updateBadgeDef, deleteBadgeDef } from '../badges/badge.service.js';
import { createLevel, updateLevel, deleteLevel } from '../stats/addiction-level.service.js';
import { notifyRequestSubmitted, notifyRequestReviewed } from '../notifications/notifications.service.js';

type Payload = Record<string, unknown>;
interface Reviewer { userId: string; ip?: string }

interface RequestSpec {
  reviewerPerm: Permission;        // permission needed to review (and to execute)
  requesterRoles: Role[];          // roles allowed to submit this type
  summarize: (p: Payload) => string;
  execute: (p: Payload, reviewer: Reviewer) => Promise<void>;
}

const num = (v: unknown): number => Number(v) || 0;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Maps each request type to who may submit/review it and how an approval is
// executed. The executor runs the real action with the reviewer as the actor,
// so existing audit logging + side effects apply unchanged.
const SPEC: Record<RequestType, RequestSpec> = {
  block_ip: {
    reviewerPerm: 'network.block',
    requesterRoles: ['mod'],
    summarize: p => `Block IP ${str(p.ip)}${p.reason ? ` — ${str(p.reason)}` : ''}`,
    execute: async (p, r) => {
      const res = await adminService.blockIp(str(p.ip), str(p.reason), r.userId, r.ip);
      if (res.error) throw new Error(String(res.error));
    },
  },
  block_device: {
    reviewerPerm: 'network.block',
    requesterRoles: ['mod'],
    summarize: p => `Block device ${str(p.deviceId)}${p.reason ? ` — ${str(p.reason)}` : ''}`,
    execute: async (p, r) => {
      const res = await adminService.blockDevice(str(p.deviceId), str(p.reason), r.userId, r.ip);
      if (res.error) throw new Error(String(res.error));
    },
  },
  xp_adjust: {
    reviewerPerm: 'xp.adjust',
    requesterRoles: ['admin'],
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
    reviewerPerm: 'badges.manage', requesterRoles: ['admin'],
    summarize: p => `Create badge "${str((p.input as { label?: { en?: string } })?.label?.en) || '?'}"`,
    execute: async (p, r) => { await createBadgeDef(p.input as Parameters<typeof createBadgeDef>[0], r.userId); },
  },
  badge_update: {
    reviewerPerm: 'badges.manage', requesterRoles: ['admin'],
    summarize: p => `Update badge "${str(p.id)}"`,
    execute: async (p) => { await updateBadgeDef(str(p.id), p.input as Parameters<typeof updateBadgeDef>[1]); },
  },
  badge_delete: {
    reviewerPerm: 'badges.manage', requesterRoles: ['admin'],
    summarize: p => `Delete badge "${str(p.id)}"`,
    execute: async (p) => { await deleteBadgeDef(str(p.id)); },
  },
  level_create: {
    reviewerPerm: 'levels.manage', requesterRoles: ['admin'],
    summarize: p => `Create level "${str((p.input as { title?: { en?: string } })?.title?.en) || '?'}"`,
    execute: async (p) => { await createLevel(p.input as Parameters<typeof createLevel>[0]); },
  },
  level_update: {
    reviewerPerm: 'levels.manage', requesterRoles: ['admin'],
    summarize: p => `Update level "${str(p.id)}"`,
    execute: async (p) => { await updateLevel(str(p.id), p.input as Parameters<typeof updateLevel>[1]); },
  },
  level_delete: {
    reviewerPerm: 'levels.manage', requesterRoles: ['admin'],
    summarize: p => `Delete level "${str(p.id)}"`,
    execute: async (p) => { await deleteLevel(str(p.id)); },
  },
};

export function isRequestType(t: string): t is RequestType {
  return (REQUEST_TYPES as readonly string[]).includes(t);
}

/** Request types the given role is allowed to submit. */
export function submittableTypes(role: string): RequestType[] {
  return REQUEST_TYPES.filter(t => (SPEC[t].requesterRoles as string[]).includes(role));
}

/** Request types the given permission set is allowed to review. */
export function reviewableTypes(permissions: string[]): RequestType[] {
  return REQUEST_TYPES.filter(t => hasPermission(permissions, SPEC[t].reviewerPerm));
}

export async function createRequest(
  requester: { userId: string; role: string; name: string },
  type: string,
  payload: Payload
): Promise<IStaffRequest> {
  if (!isRequestType(type)) throw Object.assign(new Error('Invalid request type'), { status: 400 });
  const spec = SPEC[type];
  if (!(spec.requesterRoles as string[]).includes(requester.role)) {
    throw Object.assign(new Error('Your role cannot submit this request'), { status: 403 });
  }

  const doc = await StaffRequest.create({
    issuer: { id: new mongoose.Types.ObjectId(requester.userId), name: requester.name },
    type,
    payload,
    summary: spec.summarize(payload),
    status: 'pending',
  });

  // Notify everyone who can review this type (holds the reviewer permission).
  const reviewers = await User.find({
    isDeleted: { $ne: true },
    $or: [{ permissions: spec.reviewerPerm }, { permissions: WILDCARD }],
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
  return StaffRequest.find({ status: 'pending', type: { $in: types } })
    .sort({ createdAt: 1 }).limit(200).lean<IStaffRequest[]>();
}

export async function reviewRequest(
  reviewer: { userId: string; permissions: string[]; ip?: string },
  requestId: string,
  decision: 'approve' | 'reject',
  note?: string
): Promise<IStaffRequest> {
  const req = await StaffRequest.findById(requestId);
  if (!req) throw Object.assign(new Error('Request not found'), { status: 404 });
  if (req.status !== 'pending') throw Object.assign(new Error('Request already resolved'), { status: 409 });

  const spec = SPEC[req.type];
  if (!hasPermission(reviewer.permissions, spec.reviewerPerm)) {
    throw Object.assign(new Error('You cannot review this request'), { status: 403 });
  }
  if (req.issuer.id.toString() === reviewer.userId) {
    throw Object.assign(new Error('You cannot review your own request'), { status: 403 });
  }

  const me = await User.findById(reviewer.userId).select('accountName').lean<IUser>();
  const reviewerName = me?.accountName ?? 'System';

  if (decision === 'approve') {
    try {
      await spec.execute(req.payload as Payload, { userId: reviewer.userId, ip: reviewer.ip });
    } catch (err) {
      // Leave the request pending so it can be retried after the cause is fixed.
      req.error = (err as Error)?.message ?? 'Execution failed';
      await req.save();
      throw err;
    }
    req.status = 'approved';
    req.error = null;
  } else {
    req.status = 'rejected';
  }
  req.reviewer = { id: new mongoose.Types.ObjectId(reviewer.userId), name: reviewerName };
  req.decisionNote = note ?? null;
  req.resolvedAt = new Date();
  await req.save();

  notifyRequestReviewed(req.issuer.id.toString(), req._id.toString(), req.summary, decision === 'approve').catch(() => {});
  return req;
}
