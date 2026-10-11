import type mongoose from 'mongoose';

/**
 * Owner-visibility: the single predicate for "may this user's content be seen".
 *
 * Content surfaces used to filter on content state alone (`public: true`,
 * `isPublic: true`) and never joined to the owner, so deactivating, banning or
 * shadow-banning a user left their projects in trending, in search and on
 * direct links, with their name and avatar still on the card. The invariant was
 * already written down in the OG module — "a project whose owner is
 * banned/deleted/shadow-banned is not a public surface either … or the ban is
 * trivially bypassed by sharing a project" — but enforced only there.
 *
 * Rather than join the users collection on every hot read, the two booleans
 * below are denormalized onto Project and Playlist and recomputed whenever the
 * owner's state changes. Discovery queries then add one indexed boolean and
 * keep their index-only sorts.
 *
 * TWO flags, not one, because the three moderation states are not equivalent:
 *
 * - `ownerActive`  — false when the owner is deactivated or banned. Gates
 *                    *everything*, including a direct link to a public project.
 *                    A banned owner's share link must 404 or the ban is a
 *                    formality.
 * - `ownerListed`  — false when `ownerActive` is false OR the owner is
 *                    search-shadow-banned. Gates discovery only: trending,
 *                    search, popular playlists, crawler cards.
 *
 * The split exists because a shadow ban is meant to be *silent*. Hiding a
 * shadow-banned user's project from a direct link would make the shadow ban
 * trivially detectable by its target, which is the one thing it must not be.
 * So shadow-banned content stays reachable by link and disappears from every
 * list — exactly how the shadow ban already treats the user's own profile.
 *
 * Both fields are derived state. `syncOwnerVisibility` recomputes them from
 * scratch rather than toggling, so composing transitions is safe: lifting a ban
 * on a user who is also shadow-banned leaves them unlisted, and reactivating a
 * banned account does not resurface it.
 */

export type OwnerVisibility = {
  ownerActive: boolean;
  ownerListed: boolean;
};

/** The subset of a user document this predicate reads. */
export type VisibilitySource = {
  isDeleted?: boolean;
  ban?: { active?: boolean } | null;
  shadowBan?: { search?: boolean } | null;
};

export const VISIBLE_OWNER_SELECT = 'isDeleted ban.active shadowBan.search';

/** Content of a user who cannot be resolved is treated as hidden, never as visible. */
export function computeOwnerVisibility(user: VisibilitySource | null | undefined): OwnerVisibility {
  if (!user) return { ownerActive: false, ownerListed: false };
  const active = !user.isDeleted && !user.ban?.active;
  return {
    ownerActive: active,
    ownerListed: active && !user.shadowBan?.search,
  };
}

/** True when this user's content may appear on discovery surfaces. */
export function isOwnerListed(user: VisibilitySource | null | undefined): boolean {
  return computeOwnerVisibility(user).ownerListed;
}

/** True when this user's content may be opened at all, including by direct link. */
export function isOwnerActive(user: VisibilitySource | null | undefined): boolean {
  return computeOwnerVisibility(user).ownerActive;
}

/**
 * Recompute and persist the owner-visibility flags across every piece of
 * content this user owns. Call after any transition that changes
 * `isDeleted`, `ban.active` or `shadowBan.search`.
 *
 * Idempotent, and safe to call when nothing changed. Returns the flags applied,
 * or null if the user no longer exists.
 */
export async function syncOwnerVisibility(
  userId: string | mongoose.Types.ObjectId,
): Promise<OwnerVisibility | null> {
  const [{ default: User }, { default: Project }, { default: Playlist }] = await Promise.all([
    import('../../db/user.model.js'),
    import('../projects/project.model.js'),
    import('../../db/playlist.model.js'),
  ]);

  const user = await User.findById(userId)
    .select(VISIBLE_OWNER_SELECT)
    .lean<VisibilitySource | null>();
  if (!user) return null;

  const visibility = computeOwnerVisibility(user);

  await Promise.all([
    Project.updateMany({ userId }, { $set: visibility }),
    Playlist.updateMany({ userId }, { $set: visibility }),
  ]);

  return visibility;
}

/**
 * The flags to stamp on content being created right now. New content inherits
 * the owner's current state, so a shadow-banned user's new project is unlisted
 * from the moment it exists rather than until the next sync.
 */
export async function visibilityForNewContent(
  userId: string | mongoose.Types.ObjectId | null | undefined,
): Promise<OwnerVisibility> {
  // Anonymous/guest content has no owner to hide behind; treat it as visible
  // and let the content's own `public` flag decide.
  if (!userId) return { ownerActive: true, ownerListed: true };

  const { default: User } = await import('../../db/user.model.js');
  const user = await User.findById(userId)
    .select(VISIBLE_OWNER_SELECT)
    .lean<VisibilitySource | null>();
  return computeOwnerVisibility(user);
}
