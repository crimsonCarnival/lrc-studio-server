import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import type { JwtPayload } from 'jsonwebtoken'
import { parseCookie } from 'cookie'
import { getEnv } from '../../config/env.js'
import { checkDeviceBan, checkIpBan, verifyLiveAccessToken } from '../../plugins/auth.js'
import { isValidPublicId } from '../../socket/project-viewers.js'
import User from '../users/user.model.js'
import CollabSession from './collab-session.model.js'
import { transferGuestCredit } from './collab-credits.service.js'
import type { CollabRole } from './collab.types.js'

export type CollabPrincipal = {
  subject: string
  name: string
  role: CollabRole
  colorIndex: number
  sessionId: string
  avatarUrl?: string | null
  /** The signed-in account behind this connection. */
  accountId?: string
  /** The guest identity this sign-in just absorbed: its other live connections must be moved off it. */
  replacedSubject?: string
}
export type CollabAuthCode = 'forbidden' | 'unauthorized' | 'session_ended'
export type GuestClaims = { guestId: string; name: string; sessionId: string; inviteId: string }

export class CollabAuthError extends Error {
  constructor(public readonly code: CollabAuthCode) {
    super(code)
  }
}

export const GUEST_COOKIE = 'collabGuest'
const GUEST_SCOPE = 'collab-guest'
const GUEST_TTL = '12h'
const MAX_NAME = 40
const COLOURS = 8
/** Members one session holds: it is one Mongo document, and these grow from anyone holding a link. */
export const MAX_MEMBERS = 50
/**
 * Guest identities one member remembers, newest kept. A guest token lives 12 hours, so only someone
 * minting this many guests in that window loses one, and they could mint a fresh one from the link anyway.
 */
const MAX_ABSORBED_GUESTS = 10
/** How long an invite link works. A guest's cookie outlives it by at most its own 12 hours. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const inviteExpired = (i: { createdAt: Date }): boolean => Date.now() - new Date(i.createdAt).getTime() > INVITE_TTL_MS

// Domain-separated from JWT_SECRET exactly like the admin sudo key, so a guest
// token can never verify as an access/refresh token (and vice versa).
function guestSecret(): string {
  const env = getEnv()
  if (env.COLLAB_GUEST_SECRET) return env.COLLAB_GUEST_SECRET
  return crypto.createHmac('sha256', env.JWT_SECRET).update('collab-guest-v1').digest('hex')
}

export function signGuestToken(p: GuestClaims): string {
  return jwt.sign(
    { scope: GUEST_SCOPE, name: p.name, sid: p.sessionId, inv: p.inviteId },
    guestSecret(),
    { subject: p.guestId, expiresIn: GUEST_TTL, algorithm: 'HS256' },
  )
}

export function verifyGuestToken(token: string): GuestClaims | null {
  try {
    const d = jwt.verify(token, guestSecret(), { algorithms: ['HS256'] }) as JwtPayload
    if (d.scope !== GUEST_SCOPE) return null
    if (typeof d.sub !== 'string' || typeof d.name !== 'string' || typeof d.sid !== 'string' || typeof d.inv !== 'string') return null
    return { guestId: d.sub, name: d.name, sessionId: d.sid, inviteId: d.inv }
  } catch {
    return null
  }
}

type SignedInUser = { id: string; name: string; role: string; avatarUrl: string | null }

/**
 * The signed-in user behind the accessToken cookie, or null when there is no
 * usable token. A banned account throws instead of returning null: it must be
 * refused outright, never downgraded to the guest path. Same account gates as
 * requireAuth (plugins/auth.ts), including expiring a timed-out ban.
 */
async function signedInUser(token: string | undefined): Promise<SignedInUser | null> {
  if (!token) return null
  let sub: string | undefined
  try {
    sub = (await verifyLiveAccessToken(token)).sub
  } catch {
    return null
  }
  if (!sub) return null
  const user = await User.findById(sub).select('isDeleted deletedAt ban appeal role accountName displayName avatarUrl')
  if (!user || user.isDeleted || user.deletedAt) return null
  await user.checkBanStatus()
  if (user.ban?.active) throw new CollabAuthError('forbidden')
  const name = (user.displayName || user.accountName || 'User').slice(0, MAX_NAME)
  return { id: sub, name, role: user.role ?? 'user', avatarUrl: user.avatarUrl ?? null }
}

/**
 * Device and IP bans, as requireAuth applies them (networkBanMessage in
 * plugins/auth.ts) — but to guests too, since a guest connection is otherwise a
 * free pass around a network ban. Superadmins stay exempt, as they are there.
 */
export async function assertNoNetworkBan(user: SignedInUser | null, ip: string | undefined, deviceId: string | undefined): Promise<void> {
  if (user?.role === 'superadmin') return
  const [deviceBanned, ipBanned] = await Promise.all([
    deviceId ? checkDeviceBan(deviceId) : null,
    ip ? checkIpBan(ip) : null,
  ])
  if (deviceBanned || ipBanned) throw new CollabAuthError('forbidden')
}

/** False once the session's owner is banned, deleted or archived: nobody is admitted to it any more. */
export async function isSessionOwnerActive(ownerId: unknown): Promise<boolean> {
  const owner = await User.findById(ownerId).select('isDeleted deletedAt ban appeal accountName')
  if (!owner || owner.isDeleted || owner.deletedAt) return false
  await owner.checkBanStatus()
  return !owner.ban?.active
}

/** Lowest colour 1–8 not taken by an existing member; wraps once all eight are used. */
export function nextColour(members: Array<{ colorIndex: number }>): number {
  const used = new Set(members.map((m) => m.colorIndex))
  for (let c = 1; c <= COLOURS; c++) if (!used.has(c)) return c
  return (members.length % COLOURS) + 1
}

export type MemberEntry = { subject: string; role: CollabRole; colorIndex: number; name: string; avatarUrl?: string | null; inviteId?: string; absorbedGuests?: string[] }

/**
 * A signed-in user presented a valid guest token for this session, so that guest is now this person.
 * The owner or an existing member keeps what they have and the guest entry goes. Anyone else takes the
 * guest entry over in place, with its role and colour: a demoted guest must not climb through the
 * invite's role. That needs `guestAccessValid`: when the owner already cut the guest's access the role
 * must not survive, so the entry just goes and the caller adds the person as a new member. Callers
 * refuse a kicked guest first. Returns the person's member entry, when there is one, and whether a
 * guest entry was actually absorbed. The filter repeats the rules, so a kick or a second tab racing
 * this cannot be overwritten.
 */
export async function absorbGuest(
  session: { _id: unknown; publicId: string; members: MemberEntry[] },
  guestSubject: string,
  user: { id: string; name: string; avatarUrl: string | null; isOwner: boolean },
  guestAccessValid: boolean,
): Promise<{ member?: MemberEntry; replaced: boolean }> {
  const subject = `user:${user.id}`
  const current = session.members.find((m) => m.subject === subject)
  if (!session.members.some((m) => m.subject === guestSubject)) return { member: current, replaced: false }

  const dropGuest = async (member?: MemberEntry) => {
    // Two writes, this one first: Mongo refuses a $pull on members alongside an update inside it.
    if (member) {
      await CollabSession.updateOne(
        { _id: session._id },
        { $push: { 'members.$[m].absorbedGuests': { $each: [guestSubject], $slice: -MAX_ABSORBED_GUESTS } } },
        { arrayFilters: [{ 'm.subject': subject, 'm.absorbedGuests': { $ne: guestSubject } }] },
      )
    }
    await CollabSession.updateOne({ _id: session._id }, { $pull: { members: { subject: guestSubject } } })
    await moveCredit(session.publicId, guestSubject, user.id, user.isOwner)
    return { member, replaced: true }
  }
  if (user.isOwner || current || !guestAccessValid) return dropGuest(current)

  const renamed = await CollabSession.findOneAndUpdate(
    { _id: session._id, kicked: { $nin: [guestSubject, subject] }, $and: [{ 'members.subject': guestSubject }, { 'members.subject': { $ne: subject } }] },
    {
      $set: { 'members.$[m].subject': subject, 'members.$[m].name': user.name, 'members.$[m].avatarUrl': user.avatarUrl },
      $unset: { 'members.$[m].inviteId': 1 },
      $push: { 'members.$[m].absorbedGuests': { $each: [guestSubject], $slice: -MAX_ABSORBED_GUESTS } },
    },
    { arrayFilters: [{ 'm.subject': guestSubject }], returnDocument: 'after' },
  ).select('members').lean<{ members: MemberEntry[] }>()
  if (renamed) {
    await moveCredit(session.publicId, guestSubject, user.id, false)
    return { member: renamed.members.find((m) => m.subject === subject), replaced: true }
  }

  // Lost a race: to a kick, to this person's own second tab, or the guest entry is already gone.
  const fresh = await CollabSession.findById(session._id).select('members kicked').lean<{ members: MemberEntry[]; kicked: string[] }>()
  if (!fresh || fresh.kicked.includes(guestSubject) || fresh.kicked.includes(subject)) throw new CollabAuthError('forbidden')
  const raced = fresh.members.find((m) => m.subject === subject)
  if (raced && fresh.members.some((m) => m.subject === guestSubject)) return dropGuest(raced)
  return { member: raced, replaced: !!raced }
}

/** Credits are bookkeeping: failing to move one must not cost the person their sign-in. */
async function moveCredit(publicId: string, guestSubject: string, userId: string, isOwner: boolean): Promise<void> {
  try {
    await transferGuestCredit(publicId, guestSubject, userId, isOwner)
  } catch (err) {
    console.error('[collab] moving a guest credit failed', { publicId, guestSubject, err })
  }
}

/**
 * Who a collab WebSocket is, for one document. Throws CollabAuthError:
 * `session_ended` when the project's only sessions have ended, `unauthorized`
 * when no usable credential was presented, `forbidden` otherwise.
 */
export async function resolvePrincipal(input: {
  cookieHeader: string
  docName: string
  /** Client IP as request.ip would derive it (trustProxy-aware). */
  ip?: string
  /** Client-supplied device id (X-Device-Id equivalent), for device bans. */
  deviceId?: string
  /** The session a reconnecting client last connected to. Absent on a first connect. */
  sessionId?: string
}): Promise<CollabPrincipal> {
  const match = /^project:(.+)$/.exec(input.docName)
  if (!match || !isValidPublicId(match[1])) throw new CollabAuthError('forbidden')
  const publicId = match[1]

  const session = await CollabSession.findOne({ publicId, endedAt: null })
  if (!session) {
    const ended = await CollabSession.exists({ publicId, endedAt: { $ne: null } })
    throw new CollabAuthError(ended ? 'session_ended' : 'forbidden')
  }
  const sessionId = session.id as string
  const members = session.members as unknown as MemberEntry[]

  const cookies = parseCookie(input.cookieHeader ?? '')
  const user = await signedInUser(cookies.accessToken)
  await assertNoNetworkBan(user, input.ip, input.deviceId)
  const isOwner = !!user && session.ownerId.toString() === user.id
  const guestToken = cookies[GUEST_COOKIE]
  const claims = guestToken ? verifyGuestToken(guestToken) : null
  // A token only ever counts in its own session.
  const guestSubject = claims && claims.sessionId === sessionId ? `guest:${claims.guestId}` : null
  // Neither a kicked account nor a kicked guest gets back in by combining the two.
  if (user && !isOwner && (session.kicked.includes(`user:${user.id}`) || (guestSubject && session.kicked.includes(guestSubject)))) {
    throw new CollabAuthError('forbidden')
  }

  let subject: string
  let name: string
  let role: CollabRole
  let inviteId: string | undefined

  if (user && isOwner) {
    subject = `user:${user.id}`
    name = user.name
    role = 'owner'
  } else {
    const userMember = user ? members.find((m) => m.subject === `user:${user.id}`) : undefined
    if (user && userMember) {
      subject = userMember.subject
      name = userMember.name
      role = userMember.role
    } else {
      if (!claims) throw new CollabAuthError(user ? 'forbidden' : 'unauthorized')
      if (claims.sessionId !== sessionId || !session.allowGuests) throw new CollabAuthError('forbidden')
      const invite = session.invites.find((i) => i._id.toString() === claims.inviteId)
      if (!invite || invite.revokedAt) throw new CollabAuthError('forbidden')
      const guestMember = members.find((m) => m.subject === `guest:${claims.guestId}`)
      role = guestMember?.role ?? (invite.role as CollabRole)
      if (user) {
        // A guest's access dies with its 12h token; an account's membership does not. So a link past
        // its life can no longer be turned into one, even while the token still lets a guest stay.
        if (inviteExpired(invite)) throw new CollabAuthError('forbidden')
        subject = `user:${user.id}`
        name = user.name
      } else {
        subject = `guest:${claims.guestId}`
        inviteId = claims.inviteId
        name = guestMember?.name ?? (claims.name.trim().slice(0, MAX_NAME) || 'Guest')
      }
    }
  }

  if (role !== 'owner' && session.kicked.includes(subject)) throw new CollabAuthError('forbidden')
  // A client from an earlier session holds Yjs items the re-seeded doc does not: merging them would
  // duplicate every line. Checked after identity, so it tells a stranger nothing about the session.
  if (input.sessionId && input.sessionId !== sessionId) throw new CollabAuthError('session_ended')
  // Banning or deleting an owner ends their sessions; this holds even if that step failed.
  if (!(await isSessionOwnerActive(session.ownerId))) throw new CollabAuthError('session_ended')

  // After every refusal above: a refused connection must not change who anyone is.
  const absorbed = user && guestSubject
    // A non-member only gets here past the guest checks above, so a role that carries over is a valid one.
    ? await absorbGuest({ _id: session._id, publicId, members }, guestSubject, { id: user.id, name: user.name, avatarUrl: user.avatarUrl, isOwner }, true)
    : null
  if (absorbed?.member && role !== 'owner') role = absorbed.member.role

  const identity = {
    subject, name, role, sessionId, avatarUrl: user?.avatarUrl ?? null,
    ...(user ? { accountId: user.id } : {}),
    ...(absorbed?.replaced && guestSubject ? { replacedSubject: guestSubject } : {}),
  }
  const existing = absorbed?.member ?? members.find((m) => m.subject === subject)
  if (existing) {
    if (user && user.avatarUrl !== existing.avatarUrl) {
      void CollabSession.updateOne(
        { _id: session._id, 'members.subject': subject },
        { $set: { 'members.$.avatarUrl': user.avatarUrl ?? null } },
      ).catch(() => {})
    }
    return { ...identity, colorIndex: existing.colorIndex }
  }

  // First connection: claim a colour and record the member. The filter keeps a
  // racing second tab of the same subject from adding a duplicate entry.
  const colorIndex = nextColour(members)
  // The owner is never kept out of their own session by the cap. For anyone else the session read
  // above may be stale, so the write itself refuses a subject kicked since.
  const admissible = role === 'owner' ? {} : { kicked: { $ne: subject }, [`members.${MAX_MEMBERS - 1}`]: { $exists: false } }
  const res = await CollabSession.updateOne(
    { _id: session._id, 'members.subject': { $ne: subject }, ...admissible },
    { $push: { members: { subject, role, colorIndex, name, avatarUrl: user?.avatarUrl ?? null, ...(inviteId ? { inviteId } : {}) } } },
  )
  if (res.modifiedCount === 0) {
    const fresh = await CollabSession.findById(session._id).select('members').lean()
    const raced = (fresh?.members as MemberEntry[] | undefined)?.find((m) => m.subject === subject)
    if (raced) return { ...identity, colorIndex: raced.colorIndex }
    throw new CollabAuthError('forbidden')
  }
  return { ...identity, colorIndex }
}
