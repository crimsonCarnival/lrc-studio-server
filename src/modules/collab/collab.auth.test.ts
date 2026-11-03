import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { jwtTools, verifyLiveAccessToken } from '../../plugins/auth.js'
import Session from '../auth/session.model.js'
import User from '../users/user.model.js'
import CollabSession from './collab-session.model.js'
import { resolvePrincipal, signGuestToken, verifyGuestToken } from './collab.auth.js'

let mongo: MongoMemoryServer

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongo.stop()
})

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Session.deleteMany({}), CollabSession.deleteMany({})])
})

let n = 0
async function mkUser(opts: { banned?: boolean } = {}): Promise<string> {
  n++
  const res = await User.collection.insertOne({
    accountName: `collabuser${n}`,
    displayName: `Collab User ${n}`,
    email: `collabuser${n}@x.test`,
    passwordHash: 'x',
    isDeleted: false,
    deletedAt: null,
    role: 'user',
    permissions: [],
    ban: { active: !!opts.banned, reason: null, until: null },
  })
  return res.insertedId.toString()
}

async function accessCookie(userId: string): Promise<string> {
  const familyId = `fam-${userId}`
  await Session.create({ userId, familyId, refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 3600_000) })
  return `accessToken=${jwtTools.signAccess({ sub: userId, familyId })}`
}

const PUBLIC_ID = 'proj123456'
const DOC = `project:${PUBLIC_ID}`

async function mkSession(over: Record<string, unknown> = {}) {
  const ownerId = (over.ownerId as string | undefined) ?? (await mkUser())
  const s = await CollabSession.create({
    publicId: PUBLIC_ID,
    ownerId,
    allowGuests: true,
    invites: [{ tokenHash: 'h1', role: 'editor' }, { tokenHash: 'h2', role: 'viewer' }],
    ...over,
  })
  return { session: s, ownerId, editorInvite: s.invites[0]._id.toString(), viewerInvite: s.invites[1]._id.toString() }
}

function guestCookie(p: { guestId: string; name: string; sessionId: string; inviteId: string }): string {
  return `collabGuest=${signGuestToken(p)}`
}

describe('resolvePrincipal', () => {
  it('owner cookie → owner', async () => {
    const { session, ownerId } = await mkSession()
    const p = await resolvePrincipal({ cookieHeader: await accessCookie(ownerId), docName: DOC })
    expect(p).toMatchObject({ subject: `user:${ownerId}`, role: 'owner', sessionId: session.id })
    expect(p.colorIndex).toBeGreaterThanOrEqual(1)
    expect(p.colorIndex).toBeLessThanOrEqual(8)
    const saved = await CollabSession.findById(session._id).lean()
    expect(saved!.members.map((m) => m.subject)).toContain(`user:${ownerId}`)
  })

  it('a guest with a valid invite gets the invite role and is saved as a member', async () => {
    const { session, editorInvite } = await mkSession()
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })
    const p = await resolvePrincipal({ cookieHeader, docName: DOC })
    expect(p).toMatchObject({ subject: 'guest:g1', name: 'Ana', role: 'editor' })
    const again = await resolvePrincipal({ cookieHeader, docName: DOC })
    expect(again.colorIndex).toBe(p.colorIndex)
    const saved = await CollabSession.findById(session._id).lean()
    expect(saved!.members.filter((m) => m.subject === 'guest:g1')).toHaveLength(1)
  })

  it('the member entry wins over the invite role', async () => {
    const { session, editorInvite } = await mkSession({
      members: [{ subject: 'guest:g1', role: 'viewer', colorIndex: 3, name: 'Ana' }],
    })
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })
    const p = await resolvePrincipal({ cookieHeader, docName: DOC })
    expect(p).toMatchObject({ role: 'viewer', colorIndex: 3 })
  })

  it('a signed-in member gets the member role; a signed-in stranger is forbidden', async () => {
    const member = await mkUser()
    const stranger = await mkUser()
    await mkSession({ members: [{ subject: `user:${member}`, role: 'editor', colorIndex: 2, name: 'M' }] })
    const p = await resolvePrincipal({ cookieHeader: await accessCookie(member), docName: DOC })
    expect(p).toMatchObject({ subject: `user:${member}`, role: 'editor' })
    await expect(resolvePrincipal({ cookieHeader: await accessCookie(stranger), docName: DOC }))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('guest token for another session → forbidden', async () => {
    const { editorInvite } = await mkSession()
    const other = new mongoose.Types.ObjectId().toString()
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: other, inviteId: editorInvite })
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('revoked invite → forbidden', async () => {
    const { session, editorInvite } = await mkSession()
    await CollabSession.updateOne({ _id: session._id, 'invites._id': editorInvite }, { $set: { 'invites.$.revokedAt': new Date() } })
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('allowGuests false → forbidden', async () => {
    const { session, editorInvite } = await mkSession({ allowGuests: false })
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('kicked subject → forbidden', async () => {
    const { session, editorInvite } = await mkSession({ kicked: ['guest:g1'] })
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('ended session → session_ended', async () => {
    const { ownerId } = await mkSession({ endedAt: new Date() })
    await expect(resolvePrincipal({ cookieHeader: await accessCookie(ownerId), docName: DOC }))
      .rejects.toMatchObject({ code: 'session_ended' })
  })

  it('no credentials → unauthorized; malformed doc name → forbidden', async () => {
    await mkSession()
    await expect(resolvePrincipal({ cookieHeader: '', docName: DOC })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(resolvePrincipal({ cookieHeader: '', docName: 'project:../x' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(resolvePrincipal({ cookieHeader: '', docName: `other:${PUBLIC_ID}` })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a banned owner is not admitted', async () => {
    const ownerId = await mkUser({ banned: true })
    await mkSession({ ownerId })
    await expect(resolvePrincipal({ cookieHeader: await accessCookie(ownerId), docName: DOC }))
      .rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('colours are distinct for the first 8 members', async () => {
    const { session, editorInvite } = await mkSession()
    const colours: number[] = []
    for (let i = 0; i < 8; i++) {
      const cookieHeader = guestCookie({ guestId: `g${i}`, name: `G${i}`, sessionId: session.id, inviteId: editorInvite })
      colours.push((await resolvePrincipal({ cookieHeader, docName: DOC })).colorIndex)
    }
    expect(new Set(colours).size).toBe(8)
    expect(colours.every((c) => c >= 1 && c <= 8)).toBe(true)
    const ninth = await resolvePrincipal({
      cookieHeader: guestCookie({ guestId: 'g9', name: 'G9', sessionId: session.id, inviteId: editorInvite }),
      docName: DOC,
    })
    expect(ninth.colorIndex).toBeGreaterThanOrEqual(1)
    expect(ninth.colorIndex).toBeLessThanOrEqual(8)
  })
})

describe('guest tokens', () => {
  const claims = { guestId: 'g1', name: 'Ana', sessionId: 's1', inviteId: 'i1' }

  it('round-trips', () => {
    expect(verifyGuestToken(signGuestToken(claims))).toEqual(claims)
  })

  it('rejects tampered, foreign-scope and access tokens', () => {
    const t = signGuestToken(claims)
    expect(verifyGuestToken(t.slice(0, -2) + 'xx')).toBeNull()
    expect(verifyGuestToken(jwtTools.signAccess({ sub: 'u1', familyId: 'f' }))).toBeNull()
    expect(verifyGuestToken('garbage')).toBeNull()
  })

  it('a guest token is never accepted as an access token', async () => {
    await expect(verifyLiveAccessToken(signGuestToken(claims))).rejects.toBeInstanceOf(jwt.JsonWebTokenError)
  })
})
