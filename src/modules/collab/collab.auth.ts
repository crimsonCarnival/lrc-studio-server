import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import type { JwtPayload } from 'jsonwebtoken'
import { parseCookie } from 'cookie'
import { getEnv } from '../../config/env.js'
import { checkDeviceBan, checkIpBan, verifyLiveAccessToken } from '../../plugins/auth.js'
import { isValidPublicId } from '../../socket/project-viewers.js'
import User from '../users/user.model.js'
import CollabSession from './collab-session.model.js'
import type { CollabRole } from './collab.types.js'

export type CollabPrincipal = { subject: string; name: string; role: CollabRole; colorIndex: number; sessionId: string }
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

type SignedInUser = { id: string; name: string; role: string }

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
  const user = await User.findById(sub).select('isDeleted deletedAt ban appeal role accountName displayName')
  if (!user || user.isDeleted || user.deletedAt) return null
  await user.checkBanStatus()
  if (user.ban?.active) throw new CollabAuthError('forbidden')
  const name = (user.displayName || user.accountName || 'User').slice(0, MAX_NAME)
  return { id: sub, name, role: user.role ?? 'user' }
}

/**
 * Device and IP bans, as requireAuth applies them (networkBanMessage in
 * plugins/auth.ts) — but to guests too, since a guest connection is otherwise a
 * free pass around a network ban. Superadmins stay exempt, as they are there.
 */
async function assertNoNetworkBan(user: SignedInUser | null, ip: string | undefined, deviceId: string | undefined): Promise<void> {
  if (user?.role === 'superadmin') return
  const [deviceBanned, ipBanned] = await Promise.all([
    deviceId ? checkDeviceBan(deviceId) : null,
    ip ? checkIpBan(ip) : null,
  ])
  if (deviceBanned || ipBanned) throw new CollabAuthError('forbidden')
}

/** Lowest colour 1–8 not taken by an existing member; wraps once all eight are used. */
function nextColour(members: Array<{ colorIndex: number }>): number {
  const used = new Set(members.map((m) => m.colorIndex))
  for (let c = 1; c <= COLOURS; c++) if (!used.has(c)) return c
  return (members.length % COLOURS) + 1
}

type MemberEntry = { subject: string; role: CollabRole; colorIndex: number; name: string }

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
  // A kicked account must not walk back in through a guest cookie it still holds.
  if (user && session.ownerId.toString() !== user.id && session.kicked.includes(`user:${user.id}`)) {
    throw new CollabAuthError('forbidden')
  }

  let subject: string
  let name: string
  let role: CollabRole

  if (user && session.ownerId.toString() === user.id) {
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
      const guestToken = cookies[GUEST_COOKIE]
      const claims = guestToken ? verifyGuestToken(guestToken) : null
      if (!claims) throw new CollabAuthError(user ? 'forbidden' : 'unauthorized')
      if (claims.sessionId !== sessionId || !session.allowGuests) throw new CollabAuthError('forbidden')
      const invite = session.invites.find((i) => i._id.toString() === claims.inviteId)
      if (!invite || invite.revokedAt) throw new CollabAuthError('forbidden')
      subject = `guest:${claims.guestId}`
      const guestMember = members.find((m) => m.subject === subject)
      name = guestMember?.name ?? (claims.name.trim().slice(0, MAX_NAME) || 'Guest')
      role = guestMember?.role ?? (invite.role as CollabRole)
    }
  }

  if (role !== 'owner' && session.kicked.includes(subject)) throw new CollabAuthError('forbidden')

  const existing = members.find((m) => m.subject === subject)
  if (existing) return { subject, name, role, colorIndex: existing.colorIndex, sessionId }

  // First connection: claim a colour and record the member. The filter keeps a
  // racing second tab of the same subject from adding a duplicate entry.
  const colorIndex = nextColour(members)
  const res = await CollabSession.updateOne(
    { _id: session._id, 'members.subject': { $ne: subject } },
    { $push: { members: { subject, role, colorIndex, name } } },
  )
  if (res.modifiedCount === 0) {
    const fresh = await CollabSession.findById(session._id).select('members').lean()
    const raced = (fresh?.members as MemberEntry[] | undefined)?.find((m) => m.subject === subject)
    if (raced) return { subject, name, role, colorIndex: raced.colorIndex, sessionId }
  }
  return { subject, name, role, colorIndex, sessionId }
}
