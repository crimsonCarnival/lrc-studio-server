import type { IUser } from './user.model.js';
import { findUserByAccountName } from './account-name.service.js';
import { hasBlocked } from '../blocks/block.service.js';

export type ProfileAccess =
  | { kind: 'missing' } // no user, deleted, or banned
  | { kind: 'hidden' } // owner blocked the viewer
  | { kind: 'stub'; user: IUser } // viewer blocked the owner: name only, no content
  | {
      kind: 'ok';
      user: IUser;
      isOwner: boolean;
      viewerId: string | null;
      projectFilter: Record<string, unknown>;
      playlistFilter: Record<string, unknown>;
    };

/**
 * Resolves who may see a profile and which of its projects and playlists they
 * may see. Shared by every query that must apply the profile's visitor rules.
 */
export async function resolveProfileAccess(
  accountName: string,
  asVisitor: boolean,
  contextUserId: string | null,
): Promise<ProfileAccess> {
  // Old account names keep resolving; callers carry the current one so the
  // client can redirect to it.
  const user = await findUserByAccountName<IUser>(accountName);
  if (!user || user.isDeleted || user.ban?.active) return { kind: 'missing' };

  // asVisitor: project the profile exactly as an anonymous visitor sees it
  // (owner's "view as others" preview). It can only remove data, never add.
  const viewerId = asVisitor ? null : contextUserId;

  // A user blocked by the profile owner cannot view that profile; a user the
  // viewer blocked shows as a name only, with nothing they made or said.
  if (contextUserId && contextUserId !== user._id.toString()) {
    if (await hasBlocked(user._id.toString(), contextUserId)) return { kind: 'hidden' };
    if (await hasBlocked(contextUserId, user._id.toString())) return { kind: 'stub', user };
  }

  const isOwner = !!viewerId && viewerId === user._id.toString();
  // Unlisted projects are not on a profile: only their owner sees them there.
  const projectFilter = isOwner ? { userId: user._id } : { userId: user._id, public: true, listed: { $ne: false } };
  const playlistFilter = isOwner ? { userId: user._id } : { userId: user._id, isPublic: true, listed: { $ne: false } };

  return { kind: 'ok', user, isOwner, viewerId, projectFilter, playlistFilter };
}
