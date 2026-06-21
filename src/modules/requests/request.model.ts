import mongoose, { type Document } from 'mongoose';

// Staff request/approval workflow. A staff member who lacks a capability submits
// a request; a member who holds the matching permission reviews it. On approval
// the underlying action is executed with the reviewer as the actor.
export const REQUEST_TYPES = [
  'block_ip',
  'block_device',
  'xp_adjust',
  'badge_create',
  'badge_update',
  'badge_delete',
  'level_create',
  'level_update',
  'level_delete',
] as const;

export type RequestType = (typeof REQUEST_TYPES)[number];
export type RequestStatus = 'pending' | 'approved' | 'rejected';

export interface IStaffRequest extends Document {
  issuer: {
    id: mongoose.Types.ObjectId;
    name: string;
  };
  type: RequestType;
  payload: Record<string, unknown>;
  summary: string;
  status: RequestStatus;
  reviewer?: {
    id?: mongoose.Types.ObjectId | null;
    name?: string | null;
  } | null;
  decisionNote?: string | null;
  resolvedAt?: Date | null;
  error?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const requestSchema = new mongoose.Schema<IStaffRequest>(
  {
    issuer: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      name: { type: String, required: true }
    },
    type: { type: String, enum: REQUEST_TYPES, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    // Set only once the request is reviewed — pending requests have no reviewer.
    reviewer: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      name: { type: String, default: null }
    },
    decisionNote: { type: String, default: null, maxlength: 500 },
    resolvedAt: { type: Date, default: null },
    // If auto-execution failed after approval, the reason is recorded here.
    error: { type: String, default: null },
  },
  { timestamps: true, collection: 'staff_requests' }
);

// Resolved requests auto-expire after 90 days; pending ones persist.
requestSchema.index(
  { resolvedAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60, partialFilterExpression: { resolvedAt: { $type: 'date' } } }
);

export default mongoose.model<IStaffRequest>('StaffRequest', requestSchema);
