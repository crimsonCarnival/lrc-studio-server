/**
 * Collaborator credits: who, other than the owner, actually edited a project
 * during a collaborative session. Recorded from the Hocuspocus change hook,
 * persisted on the Project (so they outlive the session and the loaded doc) and
 * resolved to current names/avatars at read time.
 */
import mongoose from 'mongoose'
import Project, { MAX_PROJECT_COLLABORATORS, type ProjectCollaboratorCredit } from '../projects/project.model.js'
import User from '../users/user.model.js'
import { isOwnerListed, VISIBLE_OWNER_SELECT, type VisibilitySource } from '../users/owner-visibility.service.js'
import { stripHtml } from '../../utils/sanitize.js'
import type { CollabPrincipal } from './collab.auth.js'

/**
 * Subjects already handled per loaded doc: credited, refused (removed/at the cap) or removed by the
 * owner mid-session. Lets the change hook skip the DB after the first change of a subject.
 */
const handled = new Map<string, Set<string>>()

export function handledSubjects(docName: string): Set<string> {
  let set = handled.get(docName)
  if (!set) handled.set(docName, (set = new Set()))
  return set
}

/** Only touches a doc that is loaded, so removing a credit never allocates an entry. */
export function markHandled(docName: string, subject: string): void {
  handled.get(docName)?.add(subject)
}

export function clearHandled(docName: string): void {
  handled.delete(docName)
}

// Control characters and bidi overrides could reorder or hide text on a public surface.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g

/** Guest names are typed by strangers and shown publicly: strip markup, control and bidi characters. */
export function cleanGuestName(raw: string): string | null {
  const cleaned = stripHtml(raw).replace(UNSAFE_NAME_CHARS, '').trim()
  return cleaned || null
}

/**
 * One atomic write. The filter is the rule: the subject is not already credited, was not removed by
 * the owner, and the project is under the cap. No match simply means nothing to do.
 */
export async function creditCollaborator(publicId: string, principal: Pick<CollabPrincipal, 'subject' | 'name'>): Promise<void> {
  const { subject } = principal
  const isUser = subject.startsWith('user:')
  const userId = isUser ? subject.slice('user:'.length) : null
  if (isUser && !mongoose.isValidObjectId(userId)) return
  const credit: ProjectCollaboratorCredit = {
    subject,
    userId: userId ? new mongoose.Types.ObjectId(userId) : null,
    guestName: isUser ? null : cleanGuestName(principal.name),
    firstContributedAt: new Date(),
  }
  await Project.updateOne(
    {
      publicId,
      'collaborators.subject': { $ne: subject },
      removedCollaborators: { $ne: subject },
      [`collaborators.${MAX_PROJECT_COLLABORATORS - 1}`]: { $exists: false },
    },
    { $push: { collaborators: credit } },
    // A credit is not a content change; keep updatedAt meaningful.
    { timestamps: false },
  )
}

/**
 * A credited guest signed in: the credit becomes the account's, keeping when it was earned, unless the
 * account is the owner (never credited) or already has its own. An owner's removal of the guest follows
 * the person to the account, so signing in cannot undo it. Each write's filter is its own rule.
 */
export async function transferGuestCredit(publicId: string, guestSubject: string, userId: string, isOwner: boolean): Promise<void> {
  const subject = `user:${userId}`
  if (!isOwner) {
    await Project.updateOne({ publicId, removedCollaborators: guestSubject }, { $addToSet: { removedCollaborators: subject } }, { timestamps: false })
    await Project.updateOne(
      { publicId, $and: [{ 'collaborators.subject': guestSubject }, { 'collaborators.subject': { $ne: subject } }] },
      { $set: { 'collaborators.$[c].subject': subject, 'collaborators.$[c].userId': new mongoose.Types.ObjectId(userId), 'collaborators.$[c].guestName': null } },
      { arrayFilters: [{ 'c.subject': guestSubject }], timestamps: false },
    )
  }
  // Only something left over: the rewrite above already took it otherwise.
  await Project.updateOne({ publicId, 'collaborators.subject': guestSubject }, { $pull: { collaborators: { subject: guestSubject } } }, { timestamps: false })
}

export type CollaboratorView = {
  id: string
  user: unknown | null
  name: string
  isGuest: boolean
}

export type ProjectCredits = { public: boolean; userId: unknown; collaborators: CollaboratorView[] }

/**
 * Credits for these projects, resolved for display. Signed-in collaborators use their current name;
 * the ones that are not publicly visible (deleted, banned, shadow-banned: the same predicate that
 * hides an owner's content) are dropped, as are accounts that no longer exist. Ordered by
 * firstContributedAt ascending. `public` and `userId` come back so the caller can apply the
 * project's own visibility check.
 */
export async function loadProjectCredits(publicIds: string[]): Promise<Map<string, ProjectCredits>> {
  const projects = await Project.find({ publicId: { $in: publicIds } })
    .select('publicId public userId collaborators')
    .lean<Array<{ publicId: string; public?: boolean; userId?: unknown; collaborators?: ProjectCollaboratorCredit[] }>>()

  const userIds = [...new Set(projects.flatMap((p) => (p.collaborators ?? []).map((c) => c.userId?.toString()).filter((id): id is string => !!id)))]
  const users = userIds.length === 0 ? [] : await User.find({ _id: { $in: userIds } })
    .select(`${VISIBLE_OWNER_SELECT} accountName displayName avatarUrl role isVerified progression`)
    .lean<Array<VisibilitySource & { _id: { toString(): string }; displayName?: string; accountName?: string }>>()
  const byId = new Map(users.map((u) => [u._id.toString(), u]))

  const out = new Map<string, ProjectCredits>()
  for (const p of projects) {
    const sorted = [...(p.collaborators ?? [])].sort((a, b) => +new Date(a.firstContributedAt) - +new Date(b.firstContributedAt))
    const collaborators: CollaboratorView[] = []
    for (const c of sorted) {
      if (c.userId) {
        const u = byId.get(c.userId.toString())
        if (!u || !isOwnerListed(u)) continue
        collaborators.push({ id: c.subject, user: u, name: u.displayName || u.accountName || '', isGuest: false })
      } else if (c.guestName) {
        collaborators.push({ id: c.subject, user: null, name: c.guestName, isGuest: true })
      }
    }
    out.set(p.publicId, { public: p.public === true, userId: p.userId, collaborators })
  }
  return out
}
