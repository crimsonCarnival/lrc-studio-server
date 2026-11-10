import ProfileShare from './profile-share.model.js';
import Project, { type IProject } from './project.model.js';
import { findUserByAccountName } from '../users/account-name.service.js';
import type { IUser } from '../users/user.model.js';
import { getBlockedSet, hasBlocked } from '../blocks/block.service.js';

export interface ProfileSharePage {
  items: { sharedAt: string; description: string; tags: string[]; project: IProject }[];
  hasMore: boolean;
}

export interface ShareNote {
  description: string;
  tags: string[];
}

export const SHARE_DESCRIPTION_MAX = 500;
export const SHARE_TAGS_MAX = 10;
export const SHARE_TAG_MAX = 30;

export class ShareNoteError extends Error {
  constructor(public readonly code: 'share_description_too_long' | 'share_too_many_tags' | 'share_tag_invalid') {
    super(code);
  }
}

// A tag is one word: letters (any script), digits, `_` and `-`. No spaces, so it
// can be shown as `#tag` and searched by later.
const TAG_RE = /^[\p{L}\p{N}_-]+$/u;

/**
 * Validates and normalizes a share's note. Over-limit input is rejected rather than
 * truncated, so a user never sees a shortened version of what they wrote; the client
 * enforces the same limits first. A leading `#` on a tag is dropped, and tags that
 * differ only in case collapse to the first one given.
 */
export function normalizeShareNote(input: { description?: string | null; tags?: string[] | null } | null | undefined): ShareNote {
  // eslint-disable-next-line no-control-regex
  const description = (input?.description ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (description.length > SHARE_DESCRIPTION_MAX) throw new ShareNoteError('share_description_too_long');

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input?.tags ?? []) {
    const tag = raw.trim().replace(/^#+/, '');
    if (!tag) continue;
    if (tag.length > SHARE_TAG_MAX || !TAG_RE.test(tag)) throw new ShareNoteError('share_tag_invalid');
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > SHARE_TAGS_MAX) throw new ShareNoteError('share_too_many_tags');

  return { description, tags };
}

const MAX_LIMIT = 50;
const EMPTY: ProfileSharePage = { items: [], hasMore: false };

/**
 * The projects a user shared to their profile, newest share first.
 *
 * Follows publicProfile's visibility: nothing for a deleted or banned sharer, or
 * when either side blocked the other. A share only shows while its project is
 * still public and its owner active, and never when the viewer and the project's
 * owner are in a block relationship. Those are filtered after paging, so a page
 * can come back short; `hasMore` follows the unfiltered query, as the feed does.
 */
export async function listProfileShares(
  accountName: string,
  viewerId: string | null,
  offset = 0,
  limit = 20
): Promise<ProfileSharePage> {
  const sharer = await findUserByAccountName<IUser>(accountName);
  if (!sharer || sharer.isDeleted || sharer.ban?.active) return EMPTY;
  const sharerId = sharer._id.toString();
  if (viewerId && viewerId !== sharerId) {
    if (await hasBlocked(sharerId, viewerId) || await hasBlocked(viewerId, sharerId)) return EMPTY;
  }

  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
  const shares = await ProfileShare.find({ userId: sharer._id })
    .sort({ createdAt: -1 })
    .skip(safeOffset)
    .limit(safeLimit + 1)
    .lean<{ publicId: string; description?: string; tags?: string[]; createdAt: Date }[]>();
  const page = shares.slice(0, safeLimit);
  if (page.length === 0) return EMPTY;

  const projects = await Project.find({
    publicId: { $in: page.map((s) => s.publicId) },
    public: true,
    listed: { $ne: false },
    ownerActive: { $ne: false },
  }).lean<IProject[]>();
  const blocked = await getBlockedSet(viewerId);
  const byId = new Map(
    projects
      .filter((p) => !p.userId || !blocked.has(p.userId.toString()))
      .map((p) => [p.publicId, p])
  );

  return {
    items: page.flatMap((s) => {
      const project = byId.get(s.publicId);
      return project
        ? [{ sharedAt: new Date(s.createdAt).toISOString(), description: s.description ?? '', tags: s.tags ?? [], project }]
        : [];
    }),
    hasMore: shares.length > safeLimit,
  };
}
