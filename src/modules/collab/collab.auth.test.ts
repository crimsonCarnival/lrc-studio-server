import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { jwtTools, verifyLiveAccessToken } from '../../plugins/auth.js'
import Session from '../auth/session.model.js'
import User from '../users/user.model.js'
import CollabSession from './collab-session.model.js'
import BannedIp from '../admin/banned-ip.model.js'
import BannedDevice from '../admin/banned-device.model.js'
import Project from '../projects/project.model.js'
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
  await Promise.all([User.deleteMany({}), Session.deleteMany({}), CollabSession.deleteMany({}), BannedIp.deleteMany({}), BannedDevice.deleteMany({})])
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
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a banned user is refused outright, not downgraded to their guest cookie', async () => {
    const banned = await mkUser({ banned: true })
    const { session, editorInvite } = await mkSession()
    const cookieHeader = `${await accessCookie(banned)}; ${guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })}`
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a kicked user cannot rejoin through a guest cookie', async () => {
    const kickedUser = await mkUser()
    const { session, editorInvite } = await mkSession({ kicked: [`user:${kickedUser}`] })
    const cookieHeader = `${await accessCookie(kickedUser)}; ${guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })}`
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('IP and device bans refuse guests and users; superadmins are exempt', async () => {
    const { session, editorInvite, ownerId } = await mkSession()
    await BannedIp.create({ ip: '203.0.113.7' })
    await BannedDevice.create({ deviceId: 'dev-bad' })
    const guestHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: session.id, inviteId: editorInvite })
    await expect(resolvePrincipal({ cookieHeader: guestHeader, docName: DOC, ip: '203.0.113.7' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(resolvePrincipal({ cookieHeader: guestHeader, docName: DOC, deviceId: 'dev-bad' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(resolvePrincipal({ cookieHeader: await accessCookie(ownerId), docName: DOC, ip: '203.0.113.7' }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await expect(resolvePrincipal({ cookieHeader: guestHeader, docName: DOC, ip: '198.51.100.1', deviceId: 'dev-ok' }))
      .resolves.toMatchObject({ role: 'editor' })
    await User.updateOne({ _id: ownerId }, { $set: { role: 'superadmin' } })
    await expect(resolvePrincipal({ cookieHeader: await accessCookie(ownerId), docName: DOC, ip: '203.0.113.7' }))
      .resolves.toMatchObject({ role: 'owner' })
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

describe('a guest who signs in', () => {
  const G = 'guest:g1'
  const guestEntry = (over: Record<string, unknown> = {}) => ({ subject: G, role: 'editor', colorIndex: 5, name: 'Ana', inviteId: 'x', ...over })
  const both = async (userId: string, p: { session: { id: string }; editorInvite: string }, sessionId = p.session.id) =>
    `${await accessCookie(userId)}; ${guestCookie({ guestId: 'g1', name: 'Ana', sessionId, inviteId: p.editorInvite })}`
  const membersOf = async (id: unknown) => (await CollabSession.findById(id).lean())!.members

  beforeEach(() => Project.deleteMany({}))

  it('renames the guest entry in place: same colour and role, no invite, the account name and avatar', async () => {
    const u = await mkUser()
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(u) }, { $set: { avatarUrl: 'https://cdn.test/a.png' } })
    const p = await mkSession({ members: [guestEntry()] })
    const res = await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    expect(res).toMatchObject({ subject: `user:${u}`, role: 'editor', colorIndex: 5, accountId: u, replacedSubject: G, avatarUrl: 'https://cdn.test/a.png' })
    const members = await membersOf(p.session._id)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ subject: `user:${u}`, role: 'editor', colorIndex: 5, name: expect.stringContaining('Collab User'), avatarUrl: 'https://cdn.test/a.png' })
    expect(members[0].inviteId).toBeUndefined()
  })

  it('a demoted guest stays a viewer rather than climbing through the invite role', async () => {
    const u = await mkUser()
    const p = await mkSession({ members: [guestEntry({ role: 'viewer' })] })
    const res = await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    expect(res).toMatchObject({ subject: `user:${u}`, role: 'viewer' })
    expect((await membersOf(p.session._id))[0].role).toBe('viewer')
  })

  it('signing in does not evade a kick, unless it is the owner', async () => {
    const u = await mkUser()
    const member = await mkUser()
    const p = await mkSession({ kicked: [G], members: [{ subject: `user:${member}`, role: 'editor', colorIndex: 1, name: 'M' }] })
    await expect(resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(resolvePrincipal({ cookieHeader: await both(member, p), docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([`user:${member}`])
    await expect(resolvePrincipal({ cookieHeader: await both(p.ownerId, p), docName: DOC })).resolves.toMatchObject({ role: 'owner' })
  })

  it('the owner drops the guest entry and stays the owner', async () => {
    const p = await mkSession({ members: [guestEntry()] })
    const res = await resolvePrincipal({ cookieHeader: await both(p.ownerId, p), docName: DOC })
    expect(res).toMatchObject({ subject: `user:${p.ownerId}`, role: 'owner', replacedSubject: G })
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([`user:${p.ownerId}`])
  })

  it('someone already a member drops the guest entry and keeps their role and colour', async () => {
    const u = await mkUser()
    const p = await mkSession({ members: [guestEntry(), { subject: `user:${u}`, role: 'viewer', colorIndex: 2, name: 'M' }] })
    const res = await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    expect(res).toMatchObject({ subject: `user:${u}`, role: 'viewer', colorIndex: 2, replacedSubject: G })
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([`user:${u}`])
  })

  it('no guest entry: joins as a new member with the invite role, and nothing is replaced', async () => {
    const u = await mkUser()
    const p = await mkSession()
    const res = await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    expect(res).toMatchObject({ subject: `user:${u}`, role: 'editor' })
    expect(res.replacedSubject).toBeUndefined()
    const members = await membersOf(p.session._id)
    expect(members.map((m) => m.subject)).toEqual([`user:${u}`])
    expect(members[0].inviteId).toBeUndefined()
  })

  it('a later connect with the leftover cookie changes nothing', async () => {
    const u = await mkUser()
    const p = await mkSession({ members: [guestEntry()] })
    const cookieHeader = await both(u, p)
    await resolvePrincipal({ cookieHeader, docName: DOC })
    const again = await resolvePrincipal({ cookieHeader, docName: DOC })
    expect(again).toMatchObject({ subject: `user:${u}`, colorIndex: 5 })
    expect(again.replacedSubject).toBeUndefined()
    expect(await membersOf(p.session._id)).toHaveLength(1)
  })

  it.each([
    ['guests are off', { allowGuests: false }],
    ['the invite is revoked', { invites: [{ tokenHash: 'h1', role: 'editor', revokedAt: new Date() }] }],
    ['the invite is expired', { invites: [{ tokenHash: 'h1', role: 'editor', createdAt: new Date(Date.now() - 8 * 24 * 3600_000) }] }],
  ])('refused, with the guest entry untouched, when %s', async (_name, over) => {
    const u = await mkUser()
    const invites = (over as { invites?: unknown[] }).invites ?? [{ tokenHash: 'h1', role: 'editor' }]
    const p = await mkSession({ members: [guestEntry()], ...over, invites: [...invites, { tokenHash: 'h2', role: 'viewer' }] })
    await expect(resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([G])
  })

  it('a valid token for another session affects nothing here, for members and strangers alike', async () => {
    const u = await mkUser()
    const stranger = await mkUser()
    const p = await mkSession({ members: [guestEntry(), { subject: `user:${u}`, role: 'editor', colorIndex: 2, name: 'M' }] })
    const elsewhere = new mongoose.Types.ObjectId().toString()
    const res = await resolvePrincipal({ cookieHeader: await both(u, p, elsewhere), docName: DOC })
    expect(res.replacedSubject).toBeUndefined()
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([G, `user:${u}`])
    await expect(resolvePrincipal({ cookieHeader: await both(stranger, p, elsewhere), docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([G, `user:${u}`])
  })

  it('a tab from an earlier session is refused before anything is renamed', async () => {
    const u = await mkUser()
    const p = await mkSession({ members: [guestEntry()] })
    await expect(resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC, sessionId: 'older' })).rejects.toMatchObject({ code: 'session_ended' })
    expect((await membersOf(p.session._id)).map((m) => m.subject)).toEqual([G])
  })

  /** A kick landing right after resolvePrincipal has read the session, so it works from a stale copy. */
  function kickAfterRead(subjects: string[]) {
    const real = CollabSession.findOne.bind(CollabSession) as (f: unknown) => { exec(): Promise<unknown> }
    return vi.spyOn(CollabSession, 'findOne').mockImplementationOnce(((f: unknown) => real(f).exec().then(async (doc) => {
      await CollabSession.collection.updateOne({ publicId: PUBLIC_ID }, { $addToSet: { kicked: { $each: subjects } }, $pull: { members: { subject: { $in: subjects } } } } as never)
      return doc
    })) as never)
  }

  it('remembers absorbed guests up to a bound, newest kept, without duplicates', async () => {
    const u = await mkUser()
    const older = Array.from({ length: 10 }, (_, i) => `guest:old${i}`)
    const p = await mkSession({ members: [guestEntry(), { subject: `user:${u}`, role: 'editor', colorIndex: 2, name: 'M', absorbedGuests: older }] })
    await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    const kept = (await membersOf(p.session._id))[0].absorbedGuests!
    expect(kept).toEqual([...older.slice(1), G])
    await CollabSession.updateOne({ _id: p.session._id }, { $push: { members: guestEntry() } })
    await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    expect((await membersOf(p.session._id))[0].absorbedGuests).toEqual(kept)
  })

  describe('races', () => {
    it('two tabs promoting at once leave one row and one credit', async () => {
      const u = await mkUser()
      await Project.collection.insertOne({ publicId: PUBLIC_ID, collaborators: [{ subject: G, userId: null, guestName: 'Ana', firstContributedAt: new Date() }], removedCollaborators: [] })
      const p = await mkSession({ members: [guestEntry()] })
      const cookieHeader = await both(u, p)
      const results = await Promise.all([resolvePrincipal({ cookieHeader, docName: DOC }), resolvePrincipal({ cookieHeader, docName: DOC })])
      for (const r of results) expect(r).toMatchObject({ subject: `user:${u}`, role: 'editor', colorIndex: 5 })
      const members = await membersOf(p.session._id)
      expect(members.map((m) => m.subject)).toEqual([`user:${u}`])
      expect(members[0].absorbedGuests).toEqual([G])
      expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.collaborators.map((c) => c.subject)).toEqual([`user:${u}`])
    })

    it.each([
      ['the guest', [G]],
      ['the account', ['ACCOUNT']],
    ])('a kick of %s landing between the read and the rename wins', async (_name, targets) => {
      const u = await mkUser()
      const p = await mkSession({ members: [guestEntry()] })
      const cookieHeader = await both(u, p)
      const spy = kickAfterRead(targets.map((t) => (t === 'ACCOUNT' ? `user:${u}` : t)))
      await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
      spy.mockRestore()
      expect((await membersOf(p.session._id)).map((m) => m.subject)).not.toContain(`user:${u}`)
    })
  })

  it('a stale read cannot re-add a subject kicked meanwhile', async () => {
    const p = await mkSession()
    const cookieHeader = guestCookie({ guestId: 'g1', name: 'Ana', sessionId: p.session.id, inviteId: p.editorInvite })
    const spy = kickAfterRead([G])
    await expect(resolvePrincipal({ cookieHeader, docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
    spy.mockRestore()
    expect(await membersOf(p.session._id)).toEqual([])
  })

  it('moves the credit, and a failing credit write does not fail the sign-in', async () => {
    const u = await mkUser()
    await Project.collection.insertOne({ publicId: PUBLIC_ID, collaborators: [{ subject: G, userId: null, guestName: 'Ana', firstContributedAt: new Date() }], removedCollaborators: [] })
    const p = await mkSession({ members: [guestEntry()] })
    await resolvePrincipal({ cookieHeader: await both(u, p), docName: DOC })
    const after = (await Project.findOne({ publicId: PUBLIC_ID }).lean())!.collaborators
    expect(after.map((c) => c.subject)).toEqual([`user:${u}`])

    await CollabSession.deleteMany({})
    const u2 = await mkUser()
    const p2 = await mkSession({ members: [guestEntry()] })
    const spy = vi.spyOn(Project, 'updateOne').mockImplementation(() => { throw new Error('boom') })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(resolvePrincipal({ cookieHeader: await both(u2, p2), docName: DOC })).resolves.toMatchObject({ subject: `user:${u2}` })
    expect(logged).toHaveBeenCalled()
    spy.mockRestore()
    logged.mockRestore()
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
