import mongoose from 'mongoose';
import Project from './project.model.js';
import ProjectView from '../../db/project-view.model.js';

/** Upper bound on a client-supplied device id before it becomes an index key. */
const MAX_DEVICE_ID_LENGTH = 128;

export type RegisterViewResult = {
  /** True only when this call was the one that incremented the counter. */
  counted: boolean;
  /** The project's view count after this call. */
  viewCount: number;
};

/** UTC midnight for a moment — the dedup window and the TTL anchor. */
function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Derive the dedup key. A signed-in viewer is keyed by user id, so the count
 * follows the person across devices. An anonymous viewer is keyed by the
 * `X-Device-Id` the client already sends on every request. Returns null when
 * the caller supplies neither — such a caller cannot be deduplicated, so it
 * does not get a vote.
 */
function viewerKeyFor(userId?: string | null, deviceId?: string | null): string | null {
  if (userId) return userId;
  const device = deviceId?.trim();
  if (!device) return null;
  if (device.length > MAX_DEVICE_ID_LENGTH) return null;
  return `d:${device}`;
}

/**
 * Register a view of a public project, counting it at most once per viewer per
 * UTC day. Returns null when no such project exists; otherwise always reports
 * the current count, with `counted` saying whether this call moved it.
 *
 * This is the only place view-count policy lives. The GraphQL resolver is a
 * thin delegate — see project.resolvers.ts.
 */
export async function registerProjectView(args: {
  publicId: string;
  userId?: string | null;
  deviceId?: string | null;
}): Promise<RegisterViewResult | null> {
  const { publicId, userId, deviceId } = args;

  const project = await Project.findOne({ publicId })
    .select('userId public viewCount')
    .lean<{ userId?: mongoose.Types.ObjectId | null; public?: boolean; viewCount?: number }>();
  if (!project) return null;

  const viewCount = project.viewCount ?? 0;

  // Private projects never accumulate views. Note the deliberate asymmetry with
  // the `publicProject` query, which does let the owner READ their own private
  // project — reading is allowed, counting is not.
  if (!project.public) return { counted: false, viewCount };

  // An owner must not inflate their own count. `userId` is nullable on Project
  // (anonymous projects), so guard the comparison rather than calling
  // toString() on null.
  if (userId && project.userId && project.userId.toString() === userId) {
    return { counted: false, viewCount };
  }

  const viewerKey = viewerKeyFor(userId, deviceId);
  if (!viewerKey) return { counted: false, viewCount };

  try {
    await ProjectView.create({ viewerKey, projectId: publicId, day: utcDayStart(new Date()) });
  } catch (err) {
    // Duplicate key: already counted today. Any other failure is real and must
    // not be swallowed into a silent "not counted".
    if ((err as { code?: number }).code === 11000) return { counted: false, viewCount };
    throw err;
  }

  const updated = await Project.findOneAndUpdate(
    { publicId },
    { $inc: { viewCount: 1 } },
    { new: true, projection: { viewCount: 1 } }
  ).lean<{ viewCount?: number }>();

  return { counted: true, viewCount: updated?.viewCount ?? viewCount + 1 };
}
