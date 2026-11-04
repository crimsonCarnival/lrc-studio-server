import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import authPlugin, { jwtTools } from '../../plugins/auth.js'
import csrfPlugin from '../../plugins/csrf.js'
import rateLimitPlugin from '../../plugins/rate-limit.js'
import collabPlugin from '../../plugins/collab.js'
import { deriveErrorCode } from '../../graphql/error-code.js'
import { collabResolvers } from '../../graphql/resolvers/collab.resolvers.js'
import type { Context } from '../../graphql/resolvers/context.js'
import Session from '../auth/session.model.js'
import User from '../users/user.model.js'
import Project from '../projects/project.model.js'
import Lyrics from '../lyrics/lyrics.model.js'
import BannedIp from '../admin/banned-ip.model.js'
import CollabSession from './collab-session.model.js'
import CollabDoc from './collab-doc.model.js'
import collabRoutes from './collab.routes.js'
import { signGuestToken } from './collab.auth.js'

const ORIGIN = 'http://localhost:5173'
const PUBLIC_ID = 'svcproj001'
const DOC = `project:${PUBLIC_ID}`

let mongo: MongoMemoryServer
let app: FastifyInstance
let wsUrl: string
let ownerId: string

const Q = collabResolvers.Query
const M = collabResolvers.Mutation
const ctx = (userId: string | null): Context => ({ userId }) as Context

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (err) {
    return deriveErrorCode(err)
  }
  throw new Error('expected a rejection')
}

let n = 0
async function mkUser(opts: { banned?: boolean } = {}): Promise<string> {
  n++
  const res = await User.collection.insertOne({
    accountName: `svcuser${n}`, displayName: `Svc User ${n}`, email: `svcuser${n}@x.test`, passwordHash: 'x',
    isDeleted: false, deletedAt: null, role: 'user', permissions: [],
    ban: { active: !!opts.banned, reason: null, until: null },
  })
  return res.insertedId.toString()
}

async function cookieFor(userId: string): Promise<string> {
  const familyId = `fam-${userId}`
  if (!(await Session.exists({ familyId }))) {
    await Session.create({ userId, familyId, refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 3600_000) })
  }
  return `accessToken=${jwtTools.signAccess({ sub: userId, familyId })}`
}

async function start(): Promise<string> {
  const s = await M.startCollabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))
  return s.id
}

async function invite(role: string): Promise<string> {
  return M.createCollabInvite(null, { publicId: PUBLIC_ID, role }, ctx(ownerId))
}

// Each call comes from its own address (trustProxy is on) so the 20/min join
// limit only bites in the test that is about it.
let ipSeq = 0
function join(body: Record<string, unknown>, cookie?: string, headers: Record<string, string> = {}) {
  ipSeq++
  return app.inject({
    method: 'POST',
    url: '/collab/join',
    payload: body,
    headers: { 'sec-fetch-site': 'same-site', 'x-forwarded-for': `10.0.${ipSeq >> 8}.${ipSeq & 255}`, ...(cookie ? { cookie } : {}), ...headers },
  })
}

function setCookieValue(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === 'collabGuest')
  if (!c) throw new Error('no collabGuest cookie')
  return `collabGuest=${c.value}`
}

type Client = { provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; doc: Y.Doc; failures: string[]; headers: { Origin: string; Cookie: string } }
const open: Client[] = []

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function connectSynced(cookie: string): Promise<Client> {
  const headers = { Origin: ORIGIN, Cookie: cookie }
  class HeaderedWebSocket extends WebSocket {
    constructor(address: string) {
      super(address, { headers })
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: HeaderedWebSocket, delay: 50, minDelay: 50 })
  const doc = new Y.Doc()
  const c: Client = { provider: null as unknown as HocuspocusProvider, socket, doc, failures: [], headers }
  c.provider = new HocuspocusProvider({
    name: DOC, document: doc, websocketProvider: socket,
    onAuthenticationFailed: ({ reason }) => c.failures.push(reason),
  })
  c.provider.attach()
  open.push(c)
  await waitFor(() => c.provider.isSynced)
  return c
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  await CollabSession.init()
  app = Fastify({ trustProxy: true })
  await app.register(fastifyCookie)
  await app.register(csrfPlugin)
  await app.register(rateLimitPlugin)
  await app.register(authPlugin)
  await app.register(collabPlugin, { upgradesPerMinute: 10_000, maxConnectionsPerIp: 1_000 })
  await app.register(collabRoutes, { prefix: '/collab' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  wsUrl = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}/collab`
})

afterAll(async () => {
  await app.close()
  await mongoose.disconnect()
  await mongo.stop()
})

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Session.deleteMany({}), Project.deleteMany({}), Lyrics.deleteMany({}),
    CollabSession.deleteMany({}), CollabDoc.deleteMany({}), BannedIp.deleteMany({}),
  ])
  ownerId = await mkUser()
  await Project.collection.insertOne({
    publicId: PUBLIC_ID, userId: new mongoose.Types.ObjectId(ownerId), title: 'T', slug: 't', version: 1,
    metadata: { songName: 'Song', songArtist: 'Artist', songAlbum: 'Album' },
  })
  await Lyrics.collection.insertOne({
    publicId: PUBLIC_ID, editorMode: 'lrc', version: 1,
    sections: [{ label: null, id: null, depth: null, timestamp: null, lines: [{ id: 'l1', text: 'one' }] }],
  })
})

afterEach(async () => {
  for (const c of open.splice(0)) {
    c.provider.destroy()
    c.socket.destroy()
  }
  await new Promise((r) => setTimeout(r, 150))
})

describe('collab moderation API', () => {
  it('non-owner cannot start/kick/revoke (forbidden)', async () => {
    const stranger = await mkUser()
    expect(await codeOf(M.startCollabSession(null, { publicId: PUBLIC_ID }, ctx(stranger)))).toBe('forbidden')
    expect(await codeOf(M.startCollabSession(null, { publicId: PUBLIC_ID }, ctx(null)))).toBe('unauthorized')
    await start()
    const inviteId = (await CollabSession.findOne({ publicId: PUBLIC_ID }))!.id as string
    expect(await codeOf(M.kickCollabParticipant(null, { publicId: PUBLIC_ID, subject: 'guest:x' }, ctx(stranger)))).toBe('forbidden')
    expect(await codeOf(M.revokeCollabInvite(null, { publicId: PUBLIC_ID, inviteId }, ctx(stranger)))).toBe('forbidden')
    expect(await codeOf(M.createCollabInvite(null, { publicId: PUBLIC_ID, role: 'editor' }, ctx(stranger)))).toBe('forbidden')
    expect(await codeOf(M.endCollabSession(null, { publicId: PUBLIC_ID }, ctx(stranger)))).toBe('forbidden')
    expect(await codeOf(M.setCollabGuestAccess(null, { publicId: PUBLIC_ID, allowGuests: false }, ctx(stranger)))).toBe('forbidden')
    expect(await codeOf(M.startCollabSession(null, { publicId: 'nosuchproj' }, ctx(ownerId)))).toBe('not_found')
  })

  it('startCollabSession is idempotent while a session is live', async () => {
    const a = await start()
    const b = await start()
    expect(b).toBe(a)
    expect(await CollabSession.countDocuments({ publicId: PUBLIC_ID })).toBe(1)
  })

  it('invite token is returned once and stored hashed', async () => {
    await start()
    const token = await invite('editor')
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const raw = JSON.stringify(await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())
    expect(raw).not.toContain(token)
    const s = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    expect(s!.invites[0].tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
    const view = await Q.collabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))
    expect(view!.invites).toEqual([expect.objectContaining({ role: 'editor', revoked: false })])
    expect(JSON.stringify(view)).not.toContain(token)
  })

  it('validates invite and role arguments', async () => {
    await start()
    expect(await codeOf(invite('owner'))).toBe('collab_invalid_role')
    expect(await codeOf(invite('admin'))).toBe('collab_invalid_role')
    expect(await codeOf(M.setCollabRole(null, { publicId: PUBLIC_ID, subject: `user:${ownerId}`, role: 'viewer' }, ctx(ownerId)))).toBe('forbidden')
    const token = await invite('editor')
    const res = await join({ token, name: 'G' })
    expect(res.statusCode).toBe(200)
    const subject = (await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.members.find((m) => m.subject.startsWith('guest:'))!.subject
    expect(await codeOf(M.setCollabRole(null, { publicId: PUBLIC_ID, subject, role: 'owner' }, ctx(ownerId)))).toBe('collab_invalid_role')
    expect(await codeOf(M.setCollabRole(null, { publicId: PUBLIC_ID, subject: 'guest:nobody', role: 'viewer' }, ctx(ownerId)))).toBe('not_found')
  })

  it('collabSession shows members to participants and invites only to the owner', async () => {
    await start()
    const token = await invite('viewer')
    const member = await mkUser()
    expect((await join({ token }, await cookieFor(member))).statusCode).toBe(200)
    const asMember = await Q.collabSession(null, { publicId: PUBLIC_ID }, ctx(member))
    expect(asMember!.members.map((m) => m.subject)).toContain(`user:${member}`)
    expect(asMember!.invites).toEqual([])
    expect(await Q.collabSession(null, { publicId: PUBLIC_ID }, ctx(await mkUser()))).toBeNull()
    expect(await Q.collabSession(null, { publicId: PUBLIC_ID }, ctx(null))).toBeNull()
  })

  it('ending a session lets a new one start for the same project', async () => {
    const first = await start()
    expect(await M.endCollabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))).toBe(true)
    expect(await Q.collabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))).toBeNull()
    const second = await start()
    expect(second).not.toBe(first)
    expect(await M.endCollabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))).toBe(true)
    expect(await codeOf(M.endCollabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId)))).toBe('not_found')
  })
})

describe('POST /collab/join', () => {
  it('guest join sets an httpOnly 12h cookie and records the member with its invite', async () => {
    await start()
    const token = await invite('editor')
    const res = await join({ token, name: '  Gina  ' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, publicId: PUBLIC_ID, role: 'editor' })
    const c = res.cookies.find((x) => x.name === 'collabGuest')!
    expect(c).toMatchObject({ httpOnly: true, path: '/', maxAge: 43_200, sameSite: 'Lax' })
    const s = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    const m = s!.members.find((x) => x.subject.startsWith('guest:'))!
    expect(m).toMatchObject({ name: 'Gina', role: 'editor', inviteId: s!.invites[0]._id.toString() })
  })

  it('join with revoked token → 403', async () => {
    await start()
    const token = await invite('editor')
    const inviteId = (await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.invites[0]._id.toString()
    expect(await M.revokeCollabInvite(null, { publicId: PUBLIC_ID, inviteId }, ctx(ownerId))).toBe(true)
    const res = await join({ token, name: 'G' })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('collab_link_revoked')
  })

  it('join to an ended session, with guests disabled, or an unknown token is refused with a distinct code', async () => {
    await start()
    const token = await invite('editor')
    await M.setCollabGuestAccess(null, { publicId: PUBLIC_ID, allowGuests: false }, ctx(ownerId))
    let res = await join({ token, name: 'G' })
    expect([res.statusCode, res.json().code]).toEqual([403, 'collab_guests_disabled'])
    // Signed-in users are not guests: they still get in.
    expect((await join({ token }, await cookieFor(await mkUser()))).statusCode).toBe(200)
    res = await join({ token: 'x'.repeat(24), name: 'G' })
    expect([res.statusCode, res.json().code]).toEqual([404, 'collab_link_invalid'])
    await M.endCollabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))
    res = await join({ token, name: 'G' })
    expect([res.statusCode, res.json().code]).toEqual([403, 'collab_session_ended'])
  })

  it('join as guest with 41-char name → 400', async () => {
    await start()
    const token = await invite('editor')
    expect((await join({ token, name: 'a'.repeat(41) })).statusCode).toBe(400)
    expect((await join({ token, name: '   ' })).statusCode).toBe(400)
    expect((await join({ token })).statusCode).toBe(400)
    expect((await join({ token, name: 'a'.repeat(40) })).statusCode).toBe(200)
  })

  it('a signed-in join adds the invite role but never downgrades the owner or a higher role', async () => {
    await start()
    const viewerToken = await invite('viewer')
    const editorToken = await invite('editor')
    const owner = await join({ token: viewerToken }, await cookieFor(ownerId))
    expect(owner.json()).toEqual({ ok: true, publicId: PUBLIC_ID, role: 'owner' })
    const u = await mkUser()
    const cookie = await cookieFor(u)
    expect((await join({ token: editorToken }, cookie)).json().role).toBe('editor')
    expect((await join({ token: viewerToken }, cookie)).json().role).toBe('editor')
    const s = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    expect(s!.members.filter((m) => m.subject === `user:${u}`)).toHaveLength(1)
    expect(s!.members.find((m) => m.subject === `user:${ownerId}`)).toBeUndefined()
    expect(s!.members.find((m) => m.subject === `user:${u}`)!.role).toBe('editor')
  })

  it('a demoted member who rejoins with an editor link stays a viewer and reconnects readOnly', async () => {
    await start()
    const editorToken = await invite('editor')
    const u = await mkUser()
    const cookie = await cookieFor(u)
    expect((await join({ token: editorToken }, cookie)).json().role).toBe('editor')
    expect(await M.setCollabRole(null, { publicId: PUBLIC_ID, subject: `user:${u}`, role: 'viewer' }, ctx(ownerId))).toBe(true)
    const again = await join({ token: editorToken }, cookie)
    expect(again.json()).toEqual({ ok: true, publicId: PUBLIC_ID, role: 'viewer' })
    const s = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    expect(s!.members.find((m) => m.subject === `user:${u}`)!.role).toBe('viewer')
    const client = await connectSynced(cookie)
    expect(client.provider.authorizedScope).toBe('readonly')
  })

  it('applies the requireAuth ban gates to signed-in users and the network gates to guests', async () => {
    await start()
    const token = await invite('editor')
    const banned = await mkUser({ banned: true })
    expect((await join({ token }, await cookieFor(banned))).statusCode).toBe(403)
    await BannedIp.create({ ip: '10.1.1.1' })
    const fromBanned = { 'x-forwarded-for': '10.1.1.1' }
    expect((await join({ token, name: 'G' }, undefined, fromBanned)).statusCode).toBe(403)
    expect((await join({ token }, await cookieFor(await mkUser()), fromBanned)).statusCode).toBe(403)
    expect((await join({ token, name: 'G' })).statusCode).toBe(200)
  })

  it('a kicked user is refused with collab_kicked', async () => {
    await start()
    const token = await invite('editor')
    const u = await mkUser()
    const cookie = await cookieFor(u)
    await join({ token }, cookie)
    const res = await M.kickCollabParticipant(null, { publicId: PUBLIC_ID, subject: `user:${u}` }, ctx(ownerId))
    expect(res).toEqual({ revokedInviteId: null })
    const again = await join({ token }, cookie)
    expect([again.statusCode, again.json().code]).toEqual([403, 'collab_kicked'])
  })

  it('refuses cross-site posts and rate-limits per IP at 20/min', async () => {
    const cross = await join({ token: 'x'.repeat(24), name: 'G' }, undefined, { 'sec-fetch-site': 'cross-site' })
    expect(cross.statusCode).toBe(403)
    const codes: number[] = []
    for (let i = 0; i < 21; i++) {
      // A rotating device id must not mint a fresh bucket.
      codes.push((await join({ token: 'y'.repeat(24), name: 'G' }, undefined, { 'x-device-id': `d${i}`, 'x-forwarded-for': '10.9.9.9' })).statusCode)
    }
    expect(codes.slice(0, 20).every((c) => c !== 429)).toBe(true)
    expect(codes[20]).toBe(429)
  })
})

describe('POST /collab/join by a guest who signed in', () => {
  const cleared = (res: { cookies: Array<{ name: string; value: string; expires?: Date }> }) => {
    const c = res.cookies.find((x) => x.name === 'collabGuest')
    return !!c && c.value === '' && !!c.expires && c.expires.getTime() < Date.now()
  }
  async function asGuest(token: string): Promise<{ cookie: string; subject: string }> {
    const before = new Set((await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.members.map((m) => m.subject))
    const cookie = setCookieValue(await join({ token, name: 'Ana' }))
    const after = (await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.members.map((m) => m.subject)
    return { cookie, subject: after.find((m) => !before.has(m))! }
  }
  const members = async () => (await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.members

  it('renames the guest in place, keeps a demotion and clears the guest cookie', async () => {
    await start()
    const token = await invite('editor')
    const g = await asGuest(token)
    const colorIndex = (await members())[0].colorIndex
    await M.setCollabRole(null, { publicId: PUBLIC_ID, subject: g.subject, role: 'viewer' }, ctx(ownerId))
    const u = await mkUser()
    const res = await join({ token }, `${await cookieFor(u)}; ${g.cookie}`)
    expect(res.json()).toEqual({ ok: true, publicId: PUBLIC_ID, role: 'viewer' })
    expect(cleared(res)).toBe(true)
    const all = await members()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ subject: `user:${u}`, role: 'viewer', colorIndex, name: expect.stringContaining('Svc User') })
    expect(all[0].inviteId).toBeUndefined()
  })

  it('the rename also carries the account avatar', async () => {
    await start()
    const token = await invite('editor')
    const g = await asGuest(token)
    const u = await mkUser()
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(u) }, { $set: { avatarUrl: 'https://cdn.test/a.png' } })
    await join({ token }, `${await cookieFor(u)}; ${g.cookie}`)
    expect((await members())[0].avatarUrl).toBe('https://cdn.test/a.png')
  })

  it('a kicked guest stays out after signing in, even with a fresh link', async () => {
    await start()
    const token = await invite('editor')
    const g = await asGuest(token)
    await M.kickCollabParticipant(null, { publicId: PUBLIC_ID, subject: g.subject }, ctx(ownerId))
    const fresh = await invite('editor')
    const u = await mkUser()
    const res = await join({ token: fresh }, `${await cookieFor(u)}; ${g.cookie}`)
    expect([res.statusCode, res.json().code]).toEqual([403, 'collab_kicked'])
    expect(cleared(res)).toBe(false)
    expect(await members()).toEqual([])
    const owner = await join({ token: fresh }, `${await cookieFor(ownerId)}; ${g.cookie}`)
    expect(owner.json().role).toBe('owner')
  })

  it('the owner and an existing member drop the guest entry and keep their role', async () => {
    await start()
    const token = await invite('editor')
    const viewerToken = await invite('viewer')
    const m = await mkUser()
    await join({ token: viewerToken }, await cookieFor(m))

    const g1 = await asGuest(token)
    const asMember = await join({ token }, `${await cookieFor(m)}; ${g1.cookie}`)
    expect(asMember.json().role).toBe('viewer')
    expect(cleared(asMember)).toBe(true)
    expect((await members()).map((x) => x.subject)).toEqual([`user:${m}`])

    const g2 = await asGuest(token)
    const asOwner = await join({ token }, `${await cookieFor(ownerId)}; ${g2.cookie}`)
    expect(asOwner.json().role).toBe('owner')
    expect(cleared(asOwner)).toBe(true)
    expect((await members()).map((x) => x.subject)).toEqual([`user:${m}`])
  })

  it('moves the credit with the person', async () => {
    await start()
    const token = await invite('editor')
    const g = await asGuest(token)
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { collaborators: [{ subject: g.subject, userId: null, guestName: 'Ana', firstContributedAt: new Date() }] } })
    const u = await mkUser()
    await join({ token }, `${await cookieFor(u)}; ${g.cookie}`)
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.collaborators.map((c) => c.subject)).toEqual([`user:${u}`])
  })

  it('a live guest tab is moved off the guest identity, leaving no guest row', async () => {
    await start()
    const token = await invite('editor')
    const g = await asGuest(token)
    const tab = await connectSynced(g.cookie)
    const closes: string[] = []
    tab.socket.on('close', ({ event }: { event: { reason: string } }) => closes.push(event.reason))
    const u = await mkUser()
    const signedIn = await cookieFor(u)
    // The browser's next upgrade carries the new session and no guest cookie.
    tab.headers.Cookie = signedIn
    await join({ token }, `${signedIn}; ${g.cookie}`)
    await waitFor(() => closes.length > 0)
    expect(closes[0]).toBe('role-changed')
    await waitFor(() => tab.provider.isSynced && tab.provider.isAuthenticated)
    expect((await members()).map((x) => x.subject)).toEqual([`user:${u}`])
  })

  it("a guest token for another session is left alone: not cleared, and this session's guest entry untouched", async () => {
    await start()
    const token = await invite('editor')
    const g = await asGuest(token)
    const session = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    const elsewhere = signGuestToken({ guestId: g.subject.slice('guest:'.length), name: 'Ana', sessionId: new mongoose.Types.ObjectId().toString(), inviteId: session!.invites[0]._id.toString() })
    const u = await mkUser()
    const res = await join({ token }, `${await cookieFor(u)}; collabGuest=${elsewhere}`)
    expect(res.statusCode).toBe(200)
    expect(cleared(res)).toBe(false)
    expect((await members()).map((x) => x.subject).sort()).toEqual([g.subject, `user:${u}`].sort())
  })

  describe("when the guest's own access is gone", () => {
    const deadAccess = [
      ['its invite was revoked', { 'invites.0.revokedAt': new Date() }],
      ['its invite expired', { 'invites.0.createdAt': new Date(Date.now() - 8 * 24 * 3600_000) }],
      ['guests were turned off', { allowGuests: false }],
    ] as const

    it.each(deadAccess)('%s: the role comes from the link presented, and no guest row is left', async (_name, cut) => {
      await start()
      const g = await asGuest(await invite('editor'))
      const viewerLink = await invite('viewer')
      await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { collaborators: [{ subject: g.subject, userId: null, guestName: 'Ana', firstContributedAt: new Date() }] } })
      await CollabSession.updateOne({ publicId: PUBLIC_ID }, { $set: cut })
      const u = await mkUser()
      const res = await join({ token: viewerLink }, `${await cookieFor(u)}; ${g.cookie}`)
      expect(res.json()).toEqual({ ok: true, publicId: PUBLIC_ID, role: 'viewer' })
      expect(cleared(res)).toBe(true)
      const all = await members()
      expect(all.map((m) => [m.subject, m.role])).toEqual([[`user:${u}`, 'viewer']])
      expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.collaborators.map((c) => c.subject)).toEqual([`user:${u}`])
    })

    it('a kicked guest whose invite was revoked is still refused', async () => {
      await start()
      const g = await asGuest(await invite('editor'))
      await M.kickCollabParticipant(null, { publicId: PUBLIC_ID, subject: g.subject }, ctx(ownerId))
      expect((await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.invites[0].revokedAt).toBeTruthy()
      const viewerLink = await invite('viewer')
      const res = await join({ token: viewerLink }, `${await cookieFor(await mkUser())}; ${g.cookie}`)
      expect([res.statusCode, res.json().code]).toEqual([403, 'collab_kicked'])
      expect(await members()).toEqual([])
    })

    it('with both guests off and a revoked invite, an existing member keeps their role and the guest row goes', async () => {
      await start()
      const g = await asGuest(await invite('editor'))
      const editorLink = await invite('editor')
      const m = await mkUser()
      const cookie = await cookieFor(m)
      await join({ token: await invite('viewer') }, cookie)
      await CollabSession.updateOne({ publicId: PUBLIC_ID }, { $set: { allowGuests: false, 'invites.0.revokedAt': new Date() } })
      const res = await join({ token: editorLink }, `${cookie}; ${g.cookie}`)
      expect(res.json().role).toBe('viewer')
      expect((await members()).map((x) => x.subject)).toEqual([`user:${m}`])
    })
  })

  it('a kick landing after the read is not undone by the join', async () => {
    await start()
    const token = await invite('editor')
    const u = await mkUser()
    const real = CollabSession.findOne.bind(CollabSession) as (f: unknown) => { lean(): { exec(): Promise<unknown> } }
    const cookie = await cookieFor(u)
    const spy = vi.spyOn(CollabSession, 'findOne').mockImplementationOnce(((f: unknown) => ({
      lean: () => real(f).lean().exec().then(async (doc) => {
        await CollabSession.collection.updateOne({ publicId: PUBLIC_ID }, { $addToSet: { kicked: `user:${u}` } } as never)
        return doc
      }),
    })) as never)
    const res = await join({ token }, cookie)
    spy.mockRestore()
    expect([res.statusCode, res.json().code]).toEqual([403, 'collab_kicked'])
    expect(await members()).toEqual([])
  })

  it('a signed-in join with no guest cookie sends no cookie change', async () => {
    await start()
    const token = await invite('editor')
    const res = await join({ token }, await cookieFor(await mkUser()))
    expect(res.cookies.find((c) => c.name === 'collabGuest')).toBeUndefined()
  })
})

describe('collab moderation on live connections', () => {
  it('kick closes the subject and blocks rejoin with the same token', async () => {
    await start()
    const token = await invite('editor')
    const joined = await join({ token, name: 'Kim' })
    const cookie = setCookieValue(joined)
    const client = await connectSynced(cookie)
    const s = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    const m = s!.members.find((x) => x.subject.startsWith('guest:'))!
    const res = await M.kickCollabParticipant(null, { publicId: PUBLIC_ID, subject: m.subject }, ctx(ownerId))
    expect(res).toEqual({ revokedInviteId: s!.invites[0]._id.toString() })
    await waitFor(() => client.failures.includes('forbidden'))
    const after = await CollabSession.findOne({ publicId: PUBLIC_ID }).lean()
    expect(after!.kicked).toContain(m.subject)
    expect(after!.invites[0].revokedAt).toBeInstanceOf(Date)
    const rejoin = await join({ token, name: 'Kim2' })
    expect([rejoin.statusCode, rejoin.json().code]).toEqual([403, 'collab_link_revoked'])
    expect(await codeOf(M.kickCollabParticipant(null, { publicId: PUBLIC_ID, subject: `user:${ownerId}` }, ctx(ownerId)))).toBe('forbidden')
  })

  it('role change to viewer makes the next connection readOnly', async () => {
    await start()
    const token = await invite('editor')
    const cookie = setCookieValue(await join({ token, name: 'Rae' }))
    const client = await connectSynced(cookie)
    expect(client.provider.authorizedScope).toBe('read-write')
    const subject = (await CollabSession.findOne({ publicId: PUBLIC_ID }).lean())!.members.find((x) => x.subject.startsWith('guest:'))!.subject
    expect(await M.setCollabRole(null, { publicId: PUBLIC_ID, subject, role: 'viewer' }, ctx(ownerId))).toBe(true)
    await waitFor(() => client.provider.authorizedScope === 'readonly')
  })

  it('turning guest access off closes guest connections', async () => {
    await start()
    const token = await invite('editor')
    const client = await connectSynced(setCookieValue(await join({ token, name: 'Gus' })))
    await M.setCollabGuestAccess(null, { publicId: PUBLIC_ID, allowGuests: false }, ctx(ownerId))
    await waitFor(() => client.failures.includes('forbidden'))
  })

  it('ending a session notifies live clients and refuses their reconnect', async () => {
    await start()
    const token = await invite('editor')
    const client = await connectSynced(setCookieValue(await join({ token, name: 'End' })))
    await M.endCollabSession(null, { publicId: PUBLIC_ID }, ctx(ownerId))
    await waitFor(() => client.failures.includes('session_ended'))
  })

  it('myCollabSessions lists live sessions the caller owns or joined, never anyone elses', async () => {
    await start()
    const member = await mkUser()
    const stranger = await mkUser()
    await CollabSession.updateOne({ publicId: PUBLIC_ID, endedAt: null }, { $push: { members: { subject: `user:${member}`, role: 'editor', colorIndex: 2, name: 'Mem' } } })
    const mine = await Q.myCollabSessions(null, null, ctx(ownerId))
    expect(mine.map((x) => [x.publicId, x.role])).toEqual([[PUBLIC_ID, 'owner']])
    const theirs = await Q.myCollabSessions(null, null, ctx(member))
    expect(theirs.map((x) => [x.publicId, x.role])).toEqual([[PUBLIC_ID, 'editor']])
    expect(await Q.myCollabSessions(null, null, ctx(stranger))).toEqual([])
    expect(await codeOf(Q.myCollabSessions(null, null, ctx(null)))).toBe('unauthorized')
  })
})
