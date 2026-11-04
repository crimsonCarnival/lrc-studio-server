import crypto from 'crypto'
import mongoose from 'mongoose'
import { nanoid } from 'nanoid'
import Project from '../projects/project.model.js'
import User from '../users/user.model.js'
import { isValidPublicId } from '../../socket/project-viewers.js'
import CollabDoc from './collab-doc.model.js'
import CollabSession from './collab-session.model.js'
import {
  absorbGuest, assertNoNetworkBan, CollabAuthError, inviteExpired, isSessionOwnerActive, MAX_MEMBERS, nextColour, signGuestToken, verifyGuestToken, type MemberEntry,
} from './collab.auth.js'
import { getCollabServer, mountedCollabServer, withCollabServer } from './collab.server.js'
import type { CollabRole } from './collab.types.js'
import { cleanGuestName, markHandled } from './collab-credits.service.js'

/** Expected failure with a client-facing code; GraphQL puts `code` in extensions, REST in the body. */
export class CollabError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code)
  }
}

/**
 * Upper bounds on a session document's arrays. They grow from caller input
 * (invites and kicks from the owner, members from anyone holding a link), and the
 * session is one Mongo document, so they are capped atomically in the update filter.
 */
const MAX_INVITES = 50
const MAX_KICKED = 200
const MAX_NAME = 40
const INVITE_ROLES = new Set(['editor', 'viewer'])
/** A session nobody has touched for this long ends, once nobody is connected either. */
const SESSION_IDLE_MS = 24 * 60 * 60 * 1000
const SUBJECT_RE = /^(user|guest):[A-Za-z0-9_-]{1,64}$/

const notFound = () => new CollabError('not_found', 404)
const docNameOf = (publicId: string) => `project:${publicId}`
export const hashInviteToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex')

type InviteEntry = { _id: mongoose.Types.ObjectId; tokenHash: string; role: 'editor' | 'viewer'; revokedAt?: Date | null; createdAt: Date }
type SessionDoc = {
  _id: mongoose.Types.ObjectId
  publicId: string
  ownerId: mongoose.Types.ObjectId
  allowGuests: boolean
  invites: InviteEntry[]
  members: MemberEntry[]
  kicked: string[]
  endedAt?: Date | null
}

export type CollabParticipantView = { subject: string; name: string; role: CollabRole; colorIndex: number; avatarUrl: string | null; inviteId: string | null }
export type CollabInviteView = { id: string; role: string; revoked: boolean; createdAt: string }
export type CollabSessionView = {
  id: string
  publicId: string
  allowGuests: boolean
  members: CollabParticipantView[]
  invites: CollabInviteView[]
}

function toView(s: SessionDoc, asOwner: boolean): CollabSessionView {
  return {
    id: s._id.toString(),
    publicId: s.publicId,
    allowGuests: s.allowGuests,
    // inviteId tells the owner which guests share a link before a kick revokes it.
    members: s.members.map((m) => ({
      subject: m.subject, name: m.name, role: m.role, colorIndex: m.colorIndex, avatarUrl: m.avatarUrl ?? null,
      inviteId: asOwner ? (m.inviteId ?? null) : null,
    })),
    invites: asOwner
      ? s.invites.map((i) => ({ id: i._id.toString(), role: i.role, revoked: !!i.revokedAt || inviteExpired(i), createdAt: i.createdAt.toISOString() }))
      : [],
  }
}

export type CollabSessionSummary = {
  publicId: string
  title: string
  songName: string
  songArtist: string
  /** The caller's role in it. */
  role: CollabRole
  memberCount: number
  createdAt: string
  lastActivityAt: string
}

/** Live sessions the caller owns or is a signed-in member of (not kicked), newest activity first. */
export async function listMySessions(userId: string | null | undefined): Promise<CollabSessionSummary[]> {
  if (!userId || !mongoose.isValidObjectId(userId)) throw new CollabError('unauthorized', 401)
  const subject = `user:${userId}`
  const sessions = await CollabSession.find({
    endedAt: null,
    $or: [{ ownerId: userId }, { members: { $elemMatch: { subject } } }],
    kicked: { $ne: subject },
  })
    .sort({ lastActivityAt: -1 })
    .limit(100)
    .lean<Array<SessionDoc & { createdAt: Date; lastActivityAt: Date }>>()
  if (sessions.length === 0) return []
  const projects = await Project.find({ publicId: { $in: sessions.map((s) => s.publicId) } })
    .select('publicId title metadata')
    .lean<Array<{ publicId: string; title?: string; metadata?: { songName?: string; songArtist?: string } }>>()
  const byId = new Map(projects.map((p) => [p.publicId, p]))
  return sessions.map((s) => {
    const p = byId.get(s.publicId)
    const owner = String(s.ownerId) === userId
    return {
      publicId: s.publicId,
      title: p?.title ?? '',
      songName: p?.metadata?.songName ?? '',
      songArtist: p?.metadata?.songArtist ?? '',
      role: owner ? 'owner' : (s.members.find((m) => m.subject === subject)?.role ?? 'viewer'),
      memberCount: s.members.length,
      createdAt: s.createdAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
    }
  })
}

async function isProjectOwner(publicId: string, userId: string): Promise<boolean | null> {
  const project = await Project.findOne({ publicId }).select('userId').lean<{ userId?: unknown }>()
  if (!project) return null
  return project.userId != null && String(project.userId) === userId
}

/** Ownership from the DB on every call (security.md ownership pattern); session.ownerId is not trusted alone. */
async function requireOwner(publicId: string, userId: string | null | undefined): Promise<string> {
  if (!userId) throw new CollabError('unauthorized', 401)
  if (!isValidPublicId(publicId)) throw notFound()
  const owner = await isProjectOwner(publicId, userId)
  if (owner === null) throw notFound()
  if (!owner) throw new CollabError('forbidden', 403)
  return userId
}

async function liveSession(publicId: string): Promise<SessionDoc> {
  const s = await CollabSession.findOne({ publicId, endedAt: null }).lean<SessionDoc>()
  if (!s) throw notFound()
  return s
}

/**
 * Participants' member lists follow a membership change without a refetch. Fire and forget, after the
 * DB write: the change already happened, and a failed broadcast only leaves lists stale until the next one.
 */
function pushMembers(publicId: string): Promise<void> {
  return mountedCollabServer()?.broadcastMembers(docNameOf(publicId))
    .catch((err: unknown) => console.error('[collab] broadcasting members failed', { publicId, err })) ?? Promise.resolve()
}

/** Owners' other tabs refetch invites and guest access. */
function pushSessionSettings(publicId: string): void {
  withCollabServer((server) => server.broadcastSessionSettings(docNameOf(publicId)))
}

/** Live connections of these subjects re-authenticate; the ones no longer admitted are refused there. */
function reconnect(publicId: string, subjects: string[]): void {
  const server = getCollabServer()
  for (const subject of subjects) server.reconnectSubject(docNameOf(publicId), subject)
}

export async function getSessionView(publicId: string, userId: string | null | undefined): Promise<CollabSessionView | null> {
  if (!userId || !isValidPublicId(publicId)) return null
  const s = await CollabSession.findOne({ publicId, endedAt: null }).lean<SessionDoc>()
  if (!s) return null
  const asOwner = (await isProjectOwner(publicId, userId)) === true
  const subject = `user:${userId}`
  // Non-participants get null rather than forbidden: no hint that a session exists.
  if (!asOwner && (s.kicked.includes(subject) || !s.members.some((m) => m.subject === subject))) return null
  return toView(s, asOwner)
}

export async function startSession(publicId: string, userId: string | null | undefined): Promise<CollabSessionView> {
  const ownerId = await requireOwner(publicId, userId)
  const existing = await CollabSession.findOne({ publicId, endedAt: null }).lean<SessionDoc>()
  if (existing) return toView(existing, true)
  try {
    const created = await CollabSession.create({ publicId, ownerId })
    return toView(created.toObject() as unknown as SessionDoc, true)
  } catch (err) {
    // Two concurrent starts: the partial unique index lets exactly one live session through.
    if ((err as { code?: number }).code !== 11000) throw err
    return toView(await liveSession(publicId), true)
  }
}

export async function endSession(publicId: string, userId: string | null | undefined): Promise<true> {
  await requireOwner(publicId, userId)
  // endedAt first: connections closed below re-authenticate and must find no live session.
  const ended = await CollabSession.findOneAndUpdate({ publicId, endedAt: null }, { $set: { endedAt: new Date() } })
  if (!ended) throw notFound()
  await getCollabServer().endSession(docNameOf(publicId))
  return true
}

/**
 * Ends sessions idle for a day with nobody connected, the normal way: edits reach Lyrics. Returns
 * how many. Needs the mounted server, which is the only place live connections are known.
 */
export async function endIdleSessions(): Promise<number> {
  const server = mountedCollabServer()
  if (!server) return 0
  const cutoff = new Date(Date.now() - SESSION_IDLE_MS)
  const idle = await CollabSession.find({ endedAt: null, lastActivityAt: { $lt: cutoff } }).select('publicId').lean<Array<{ publicId: string }>>()
  let ended = 0
  for (const { publicId } of idle) {
    if (server.hasConnections(docNameOf(publicId))) continue
    // The filter repeats the cutoff: someone may have connected and left since the read.
    const res = await CollabSession.updateOne({ publicId, endedAt: null, lastActivityAt: { $lt: cutoff } }, { $set: { endedAt: new Date() } })
    if (res.modifiedCount === 0) continue
    await server.endSession(docNameOf(publicId))
    ended++
  }
  return ended
}

/**
 * Second half of deleting a project; the caller already ended its session in the delete's
 * transaction. Closes the live connections without storing and removes the stored doc, which
 * would otherwise keep serving the content. Never throws: the project is gone either way.
 */
export async function discardDeletedProject(publicId: string): Promise<void> {
  const docName = docNameOf(publicId)
  try {
    const server = mountedCollabServer()
    if (server) await server.discardSession(docName)
    else await CollabDoc.deleteOne({ name: docName })
  } catch (err) {
    console.error('[collab] discarding a deleted project failed', { publicId, err })
  }
}

/**
 * An account was banned or deleted: drop it from every session it is in, its own or anyone else's,
 * and end the ones it owns. Its projects stay (a ban can lift, a deactivated account can come back),
 * so that is a normal end that keeps the edits, not a discard. Never throws: the account change has
 * already happened.
 */
export async function disconnectAccount(userId: string): Promise<void> {
  withCollabServer((server) => server.closeUserEverywhere(userId))
  try {
    const live = await CollabSession.find({ ownerId: userId, endedAt: null }).select('publicId').lean<Array<{ publicId: string }>>()
    await Promise.all(live.map(async ({ publicId }) => {
      await CollabSession.updateOne({ publicId, endedAt: null }, { $set: { endedAt: new Date() } })
      await mountedCollabServer()?.endSession(docNameOf(publicId))
    }))
  } catch (err) {
    console.error('[collab] ending an account\'s sessions failed', { userId, err })
  }
}

/** Returns the raw token; only its sha256 is stored, so this is the one time it exists. */
export async function createInvite(publicId: string, role: string, userId: string | null | undefined): Promise<string> {
  await requireOwner(publicId, userId)
  if (!INVITE_ROLES.has(role)) throw new CollabError('collab_invalid_role', 400)
  await liveSession(publicId)
  const token = nanoid(24)
  const res = await CollabSession.updateOne(
    { publicId, endedAt: null, [`invites.${MAX_INVITES - 1}`]: { $exists: false } },
    { $push: { invites: { tokenHash: hashInviteToken(token), role } } },
  )
  if (res.modifiedCount === 0) throw new CollabError('collab_invite_limit', 409)
  pushSessionSettings(publicId)
  return token
}

export async function revokeInvite(publicId: string, inviteId: string, userId: string | null | undefined): Promise<true> {
  await requireOwner(publicId, userId)
  const s = await liveSession(publicId)
  const invite = s.invites.find((i) => i._id.toString() === inviteId)
  if (!invite) throw notFound()
  await revokeInviteIn(s, inviteId)
  pushSessionSettings(publicId)
  return true
}

/** Marks the invite revoked and drops every guest who joined with it. */
async function revokeInviteIn(s: SessionDoc, inviteId: string): Promise<void> {
  await CollabSession.updateOne(
    { _id: s._id, invites: { $elemMatch: { _id: new mongoose.Types.ObjectId(inviteId), revokedAt: null } } },
    { $set: { 'invites.$.revokedAt': new Date() } },
  )
  reconnect(s.publicId, s.members.filter((m) => m.subject.startsWith('guest:') && m.inviteId === inviteId).map((m) => m.subject))
}

export async function setRole(publicId: string, subject: string, role: string, userId: string | null | undefined): Promise<true> {
  const ownerId = await requireOwner(publicId, userId)
  if (!INVITE_ROLES.has(role)) throw new CollabError('collab_invalid_role', 400)
  if (subject === `user:${ownerId}`) throw new CollabError('forbidden', 403)
  const s = await liveSession(publicId)
  if (!s.members.some((m) => m.subject === subject)) throw notFound()
  await CollabSession.updateOne({ _id: s._id, 'members.subject': subject }, { $set: { 'members.$.role': role } })
  // Awaited (it never rejects) so the list goes out before the reconnect: the affected client then
  // shows its new role at once, and ws flushes this frame ahead of the close.
  await pushMembers(publicId)
  reconnect(publicId, [subject])
  return true
}

/**
 * Kick = add to `kicked`, drop the member entry, close their connections and
 * free their locks. A guest's invite is revoked too: `kicked` holds one guest id,
 * and the same link would mint a fresh one. That cuts off every other guest on
 * that link, which the caller learns through `revokedInviteId`.
 */
export async function kick(publicId: string, subject: string, userId: string | null | undefined): Promise<{ revokedInviteId: string | null }> {
  const ownerId = await requireOwner(publicId, userId)
  if (!SUBJECT_RE.test(subject)) throw new CollabError('collab_invalid_subject', 400)
  if (subject === `user:${ownerId}`) throw new CollabError('forbidden', 403)
  const s = await liveSession(publicId)
  const member = s.members.find((m) => m.subject === subject)
  const inviteId = subject.startsWith('guest:') ? (member?.inviteId ?? null) : null
  // Guests this account absorbed go with it, or a leftover cookie re-enters after sign-out. Their
  // links stay open: other people may hold them, and a signed-in kick has never revoked one.
  const absorbed = member?.absorbedGuests ?? []
  // The cap only ever refuses a subject who is neither a member nor connected: refusing anyone else
  // would leave them in the session the owner just removed them from. It can pass the cap that way,
  // bounded by how many people the owner actually kicks.
  const server = getCollabServer()
  const capped = { $or: [{ kicked: subject }, { 'members.subject': subject }, { [`kicked.${MAX_KICKED - 1}`]: { $exists: false } }] }
  const res = await CollabSession.updateOne(
    { _id: s._id, ...(server.hasSubject(docNameOf(publicId), subject) ? {} : capped) },
    { $addToSet: { kicked: { $each: [subject, ...absorbed] } }, $pull: { members: { subject: { $in: [subject, ...absorbed] } } } },
  )
  if (res.matchedCount === 0) throw new CollabError('collab_kick_limit', 409)
  server.closeSubject(docNameOf(publicId), subject)
  // Only those actually present: closing also tells everyone that subject was kicked.
  for (const guest of absorbed) {
    if (s.members.some((m) => m.subject === guest) || server.hasSubject(docNameOf(publicId), guest)) server.closeSubject(docNameOf(publicId), guest)
  }
  void pushMembers(publicId)
  if (inviteId) {
    await revokeInviteIn(s, inviteId)
    pushSessionSettings(publicId)
  }
  return { revokedInviteId: inviteId }
}

export async function setGuestAccess(publicId: string, allowGuests: boolean, userId: string | null | undefined): Promise<true> {
  await requireOwner(publicId, userId)
  const s = await liveSession(publicId)
  await CollabSession.updateOne({ _id: s._id }, { $set: { allowGuests } })
  if (!allowGuests) reconnect(publicId, s.members.filter((m) => m.subject.startsWith('guest:')).map((m) => m.subject))
  pushSessionSettings(publicId)
  return true
}

/**
 * Owner removes a collaborator credit. The subject is remembered so it is never credited again, and
 * the live doc (if loaded) is told so the session does not re-add it. Both changes are one update.
 */
export async function removeProjectCollaborator(publicId: string, id: string, userId: string | null | undefined): Promise<true> {
  await requireOwner(publicId, userId)
  if (!SUBJECT_RE.test(id)) throw notFound()
  // Only a currently credited subject matches, so the removed list grows with real contributors only.
  const res = await Project.updateOne(
    { publicId, 'collaborators.subject': id },
    { $addToSet: { removedCollaborators: id }, $pull: { collaborators: { subject: id } } },
    { timestamps: false },
  )
  if (res.matchedCount === 0) {
    // Already removed is success (idempotent); never credited, or the project is gone, is not_found.
    const removed = await Project.exists({ publicId, removedCollaborators: id })
    if (!removed) throw notFound()
  }
  markHandled(docNameOf(publicId), id)
  return true
}

export type JoinInput = {
  token: string
  name?: string
  /** Set only after requireAuth's gates passed for this request. */
  userId: string | null
  /** An existing collabGuest cookie, reused so a rejoin keeps its guest id. */
  guestCookie?: string
  ip?: string
  deviceId?: string
}
export type JoinResult = {
  publicId: string
  role: CollabRole
  guestToken?: string
  /** A signed-in join retired the guest cookie it arrived with. */
  clearGuestCookie?: boolean
}

/**
 * Adds `subject` with the invite's role. An existing member's role is never
 * changed by a join: the owner's setCollabRole is authoritative, and a demoted
 * member must not climb back with a link they still hold. Only a guest's
 * inviteId is refreshed, so a kick still revokes the link they last used.
 * Returns the role the member ends up with.
 */
async function upsertMember(s: SessionDoc, entry: Omit<MemberEntry, 'colorIndex'>): Promise<CollabRole> {
  const existing = s.members.find((m) => m.subject === entry.subject)
  if (existing) {
    if (entry.inviteId && entry.inviteId !== existing.inviteId) {
      await CollabSession.updateOne({ _id: s._id, 'members.subject': entry.subject }, { $set: { 'members.$.inviteId': entry.inviteId } })
    }
    return existing.role
  }
  const res = await CollabSession.updateOne(
    { _id: s._id, 'members.subject': { $ne: entry.subject }, kicked: { $ne: entry.subject }, [`members.${MAX_MEMBERS - 1}`]: { $exists: false } },
    { $push: { members: { ...entry, colorIndex: nextColour(s.members) } } },
  )
  if (res.modifiedCount === 0) {
    // Lost a race to a second tab of the same subject or to a kick, or the session is full.
    const fresh = await CollabSession.findById(s._id).select('members kicked').lean<{ members: MemberEntry[]; kicked: string[] }>()
    const raced = fresh?.members.find((m) => m.subject === entry.subject)
    if (raced) return raced.role
    throw fresh?.kicked.includes(entry.subject) ? new CollabError('collab_kicked', 403) : new CollabError('collab_session_full', 403)
  }
  void pushMembers(s.publicId)
  return entry.role
}

/** absorbGuest refuses only a kick it lost a race to; here that reads as any other kick. */
async function absorbGuestForJoin(...args: Parameters<typeof absorbGuest>): ReturnType<typeof absorbGuest> {
  try {
    return await absorbGuest(...args)
  } catch (err) {
    if (err instanceof CollabAuthError) throw new CollabError('collab_kicked', 403)
    throw err
  }
}

export async function joinSession(input: JoinInput): Promise<JoinResult> {
  const s = await CollabSession.findOne({ 'invites.tokenHash': hashInviteToken(input.token) }).lean<SessionDoc>()
  if (!s) throw new CollabError('collab_link_invalid', 404)
  if (s.endedAt || !(await isSessionOwnerActive(s.ownerId))) throw new CollabError('collab_session_ended', 403)
  const invite = s.invites.find((i) => i.tokenHash === hashInviteToken(input.token))!
  if (invite.revokedAt || inviteExpired(invite)) throw new CollabError('collab_link_revoked', 403)
  const sessionId = s._id.toString()
  const inviteId = invite._id.toString()

  if (input.userId) {
    const subject = `user:${input.userId}`
    const isOwner = String(s.ownerId) === input.userId
    const prior = input.guestCookie ? verifyGuestToken(input.guestCookie) : null
    // A token only ever counts in its own session, and one for another session is left where it is.
    const guestSubject = prior && prior.sessionId === sessionId ? `guest:${prior.guestId}` : null
    const clearGuestCookie = !!input.guestCookie && (!prior || !!guestSubject)
    if (!isOwner && (s.kicked.includes(subject) || (guestSubject && s.kicked.includes(guestSubject)))) throw new CollabError('collab_kicked', 403)
    const user = await User.findById(input.userId).select('displayName accountName avatarUrl').lean<{ displayName?: string; accountName?: string; avatarUrl?: string | null }>()
    const name = (user?.displayName || user?.accountName || 'User').slice(0, MAX_NAME)
    // The link in hand was checked above; this is the token's own invite, which may be another one.
    const tokenInvite = s.invites.find((i) => i._id.toString() === prior?.inviteId)
    const guestAccessValid = s.allowGuests && !!tokenInvite && !tokenInvite.revokedAt && !inviteExpired(tokenInvite)
    const absorbed = guestSubject ? await absorbGuestForJoin(s, guestSubject, { id: input.userId, name, avatarUrl: user?.avatarUrl ?? null, isOwner }, guestAccessValid) : null
    // A dead invite's guest entry was dropped with no member to record it on, so the new one carries it.
    const absorbedGuests = absorbed?.replaced && guestSubject ? [guestSubject] : undefined
    const role = isOwner ? 'owner' : (absorbed?.member?.role ?? await upsertMember(s, { subject, name, role: invite.role, ...(absorbedGuests ? { absorbedGuests } : {}) }))
    // Last: a live tab re-authenticating as the account must find its member entry already there.
    if (absorbed?.replaced) withCollabServer((server) => server.replaceSubject(docNameOf(s.publicId), guestSubject!, subject))
    return { publicId: s.publicId, role, ...(clearGuestCookie ? { clearGuestCookie } : {}) }
  }

  if (!s.allowGuests) throw new CollabError('collab_guests_disabled', 403)
  const name = cleanGuestName(input.name ?? '')
  if (!name || name.length > MAX_NAME) throw new CollabError('collab_invalid_name', 400)
  try {
    await assertNoNetworkBan(null, input.ip, input.deviceId)
  } catch (err) {
    if (err instanceof CollabAuthError) throw new CollabError('forbidden', 403)
    throw err
  }
  const prior = input.guestCookie ? verifyGuestToken(input.guestCookie) : null
  const guestId = prior && prior.sessionId === sessionId ? prior.guestId : nanoid()
  const subject = `guest:${guestId}`
  if (s.kicked.includes(subject)) throw new CollabError('collab_kicked', 403)
  const role = await upsertMember(s, { subject, name, role: invite.role, inviteId })
  const guestToken = signGuestToken({ guestId, name, sessionId, inviteId })
  return { publicId: s.publicId, role, guestToken }
}
