/**
 * Tags inside wall comments.
 *
 * A comment body stores tags as id tokens, never as names: `@[u:<userId>]` for a person and
 * `@[p:<publicId>]` for a project. Account names and project titles can change, ids can't,
 * and the square-bracket form survives stripHtml (a `<@…>` token would not). Tokens are
 * resolved per viewer on read, so a project title is only revealed to someone allowed to
 * see the project; anything that does not resolve is rendered as plain text by the client.
 */
import mongoose from 'mongoose';
import User from '../users/user.model.js';
import Project from '../projects/project.model.js';
import Upload from '../uploads/upload.model.js';
import { youtubeThumbnail } from '../../utils/cover-image.js';

export const MAX_TAGS_PER_COMMENT = 10;

const TOKEN = /@\[(u|p):([A-Za-z0-9_-]{1,40})\]/g;

export interface WallMention {
  id: string;
  accountName: string;
  displayName: string | null;
}

export interface WallProjectRef {
  publicId: string;
  title: string;
  slug: string;
  coverImage: string | null;
  ownerAccountName: string;
}

export interface CommentTags {
  userIds: string[];
  projectIds: string[];
}

export function parseTags(body: string): CommentTags {
  const userIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const [, kind, id] of body.matchAll(TOKEN)) (kind === 'u' ? userIds : projectIds).add(id);
  return { userIds: [...userIds], projectIds: [...projectIds] };
}

/**
 * The tags `authorId` may write: every user must exist (and not be deleted), every project
 * must exist and be visible to the author (public, or their own). Returns false otherwise,
 * so a forged or stale token rejects the comment instead of being stored.
 */
export async function tagsAreValid(authorId: string, tags: CommentTags): Promise<boolean> {
  if (tags.userIds.length + tags.projectIds.length > MAX_TAGS_PER_COMMENT) return false;
  if (tags.userIds.some((id) => !mongoose.isValidObjectId(id))) return false;
  const [users, projects] = await Promise.all([
    tags.userIds.length
      ? User.countDocuments({ _id: { $in: tags.userIds }, isDeleted: { $ne: true } })
      : 0,
    tags.projectIds.length
      ? Project.countDocuments({
          publicId: { $in: tags.projectIds },
          $or: [{ public: true }, { userId: new mongoose.Types.ObjectId(authorId) }],
        })
      : 0,
  ]);
  return users === tags.userIds.length && projects === tags.projectIds.length;
}

export interface ResolvedTags {
  users: Map<string, WallMention>;
  projects: Map<string, WallProjectRef>;
}

/** Resolves the tags of many comments at once, as `viewerId` may see them. */
export async function resolveTags(bodies: string[], viewerId: string | null): Promise<ResolvedTags> {
  const userIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const body of bodies) {
    const tags = parseTags(body);
    tags.userIds.forEach((id) => userIds.add(id));
    tags.projectIds.forEach((id) => projectIds.add(id));
  }
  const validUserIds = [...userIds].filter((id) => mongoose.isValidObjectId(id));

  const [users, projects] = await Promise.all([
    validUserIds.length
      ? User.find({ _id: { $in: validUserIds }, isDeleted: { $ne: true } })
          .select('accountName displayName')
          .lean<{ _id: mongoose.Types.ObjectId; accountName?: string; displayName?: string | null }[]>()
      : [],
    projectIds.size
      ? Project.find({
          publicId: { $in: [...projectIds] },
          // Private projects resolve only for their owner; everyone else sees plain text.
          $or: [{ public: true }, ...(viewerId ? [{ userId: new mongoose.Types.ObjectId(viewerId) }] : [])],
        })
          .select('publicId title slug coverImage userId uploadId')
          .lean<{ publicId: string; title?: string; slug?: string; coverImage?: string; userId: mongoose.Types.ObjectId | null; uploadId?: mongoose.Types.ObjectId | null }[]>()
      : [],
  ]);

  // Project owners' names and upload covers, for the cards.
  const ownerIds = [...new Set(projects.map((p) => p.userId?.toString()).filter((id): id is string => !!id))];
  const uploadIds = projects.filter((p) => !p.coverImage && p.uploadId).map((p) => p.uploadId!);
  const [owners, uploads] = await Promise.all([
    ownerIds.length
      ? User.find({ _id: { $in: ownerIds } }).select('accountName').lean<{ _id: mongoose.Types.ObjectId; accountName?: string }[]>()
      : [],
    uploadIds.length
      ? Upload.find({ _id: { $in: uploadIds } }).select('coverImage source uploadUrl').lean<{ _id: mongoose.Types.ObjectId; coverImage?: string | null; source?: string; uploadUrl?: string | null }[]>()
      : [],
  ]);
  const ownerName = new Map(owners.map((o) => [o._id.toString(), o.accountName ?? '']));
  const uploadCover = new Map(uploads.map((u) => [
    u._id.toString(),
    u.coverImage || (u.source === 'youtube' ? youtubeThumbnail(u.uploadUrl ?? '') : null),
  ]));

  const resolved: ResolvedTags = { users: new Map(), projects: new Map() };
  for (const u of users) {
    resolved.users.set(u._id.toString(), { id: u._id.toString(), accountName: u.accountName ?? '', displayName: u.displayName ?? null });
  }
  for (const p of projects) {
    const owner = p.userId ? ownerName.get(p.userId.toString()) : undefined;
    if (!owner) continue; // an ownerless (guest) project has no page to link to
    resolved.projects.set(p.publicId, {
      publicId: p.publicId,
      title: p.title ?? '',
      slug: p.slug ?? '',
      coverImage: p.coverImage || (p.uploadId ? uploadCover.get(p.uploadId.toString()) ?? null : null),
      ownerAccountName: owner,
    });
  }
  return resolved;
}

/** The resolved tags that appear in one comment's body. */
export function tagsOf(body: string, resolved: ResolvedTags): { mentions: WallMention[]; projectRefs: WallProjectRef[] } {
  const tags = parseTags(body);
  return {
    mentions: tags.userIds.map((id) => resolved.users.get(id)).filter((m): m is WallMention => !!m),
    projectRefs: tags.projectIds.map((id) => resolved.projects.get(id)).filter((p): p is WallProjectRef => !!p),
  };
}
