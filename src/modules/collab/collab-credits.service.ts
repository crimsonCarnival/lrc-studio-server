/**
 * Collaborator credits: who, other than the owner, actually edited a project
 * during a collaborative session. Recorded from the Hocuspocus change hook,
 * persisted on the Project (so they outlive the session and the loaded doc) and
 * resolved to current names/avatars at read time.
 */
import mongoose from 'mongoose'
import Project, { MAX_PROJECT_COLLABORATORS, type ProjectCollaboratorCredit } from '../projects/project.model.js'
import User from '../users/user.model.js'
import { isOwnerListed, VISIBLE_OWNER_SELECT } from '../users/owner-visibility.service.js'
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
    guestName: isUser ? null : principal.name,
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
    .lean<Array<{ _id: { toString(): string }; displayName?: string; accountName?: string }>>()
  const byId = new Map(users.map((u) => [u._id.toString(), u]))

  const out = new Map<string, ProjectCredits>()
  for (const p of projects) {
    const sorted = [...(p.collaborators ?? [])].sort((a, b) => +new Date(a.firstContributedAt) - +new Date(b.firstContributedAt))
    const collaborators: CollaboratorView[] = []
    for (const c of sorted) {
      if (c.userId) {
        const u = byId.get(c.userId.toString())
        if (!u || !isOwnerListed(u as never)) continue
        collaborators.push({ id: c.subject, user: u, name: u.displayName || u.accountName || '', isGuest: false })
      } else {
        collaborators.push({ id: c.subject, user: null, name: c.guestName ?? '', isGuest: true })
      }
    }
    out.set(p.publicId, { public: p.public === true, userId: p.userId, collaborators })
  }
  return out
}
