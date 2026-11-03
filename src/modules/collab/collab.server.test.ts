import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import collabPlugin from '../../plugins/collab.js'
import { jwtTools } from '../../plugins/auth.js'
import Session from '../auth/session.model.js'
import User from '../users/user.model.js'
import Project from '../projects/project.model.js'
import Lyrics from '../lyrics/lyrics.model.js'
import CollabSession from './collab-session.model.js'
import CollabDoc from './collab-doc.model.js'
import { signGuestToken } from './collab.auth.js'
import { getCollabServer } from './collab.server.js'

const ORIGIN = 'http://localhost:5173'
const PUBLIC_ID = 'srvproj001'
const DOC = `project:${PUBLIC_ID}`

let mongo: MongoMemoryServer
let app: FastifyInstance
let url: string
let ownerId: string
let sessionId: string
let editorInvite: string
let viewerInvite: string

type Client = {
  provider: HocuspocusProvider
  socket: HocuspocusProviderWebsocket
  doc: Y.Doc
  stateless: Array<Record<string, unknown>>
  failures: string[]
}
const open: Client[] = []

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function connect(cookie: string): Client {
  const headers = { Origin: ORIGIN, Cookie: cookie }
  class HeaderedWebSocket extends WebSocket {
    constructor(address: string) {
      super(address, { headers })
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: HeaderedWebSocket, delay: 50, minDelay: 50 })
  const doc = new Y.Doc()
  const client: Client = { provider: null as unknown as HocuspocusProvider, socket, doc, stateless: [], failures: [] }
  client.provider = new HocuspocusProvider({
    name: DOC,
    document: doc,
    websocketProvider: socket,
    onStateless: ({ payload }) => client.stateless.push(JSON.parse(payload) as Record<string, unknown>),
    onAuthenticationFailed: ({ reason }) => client.failures.push(reason),
  })
  client.provider.attach()
  open.push(client)
  return client
}

async function connectSynced(cookie: string): Promise<Client> {
  const c = connect(cookie)
  await waitFor(() => c.provider.isSynced)
  return c
}

function close(c: Client): void {
  c.provider.destroy()
  c.socket.destroy()
}

function lastLocks(c: Client): Record<string, { subject: string; holderConn: string }> | undefined {
  const msgs = c.stateless.filter((m) => m.t === 'locks')
  return msgs.at(-1)?.locks as Record<string, { subject: string; holderConn: string }> | undefined
}

function lineText(doc: Y.Doc, id: string): unknown {
  return doc.getMap<Y.Map<unknown>>('lines').get(id)?.get('text')
}

async function ownerCookie(): Promise<string> {
  const familyId = `fam-${ownerId}`
  if (!(await Session.exists({ familyId }))) {
    await Session.create({ userId: ownerId, familyId, refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 3600_000) })
  }
  return `accessToken=${jwtTools.signAccess({ sub: ownerId, familyId })}`
}

function guest(id: string, inviteId: string): string {
  return `collabGuest=${signGuestToken({ guestId: id, name: id, sessionId, inviteId })}`
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  app = Fastify()
  await app.register(collabPlugin)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as { port: number }
  url = `ws://127.0.0.1:${addr.port}/collab`
})

afterAll(async () => {
  await app.close()
  await mongoose.disconnect()
  await mongo.stop()
})

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Session.deleteMany({}), Project.deleteMany({}), Lyrics.deleteMany({}),
    CollabSession.deleteMany({}), CollabDoc.deleteMany({}),
  ])
  const u = await User.collection.insertOne({
    accountName: 'owner1', displayName: 'Owner', email: 'o@x.test', passwordHash: 'x',
    isDeleted: false, role: 'user', permissions: [], ban: { active: false },
  })
  ownerId = u.insertedId.toString()
  await Project.collection.insertOne({
    publicId: PUBLIC_ID, userId: u.insertedId, title: 'T', slug: 't', version: 1,
    metadata: { songName: 'Song', songArtist: 'Artist', songAlbum: 'Album' },
  })
  await Lyrics.collection.insertOne({
    publicId: PUBLIC_ID, editorMode: 'lrc', version: 1,
    sections: [{ label: null, id: null, depth: null, timestamp: null, lines: [{ id: 'l1', text: 'one' }, { id: 'l2', text: 'two' }] }],
  })
  const s = await CollabSession.create({
    publicId: PUBLIC_ID, ownerId, allowGuests: true,
    invites: [{ tokenHash: 'h1', role: 'editor' }, { tokenHash: 'h2', role: 'viewer' }],
  })
  sessionId = s.id
  editorInvite = s.invites[0]._id.toString()
  viewerInvite = s.invites[1]._id.toString()
})

afterEach(async () => {
  for (const c of open.splice(0)) close(c)
  // Let the server observe the disconnects and unload before the next test wipes the DB.
  await new Promise((r) => setTimeout(r, 150))
})

describe('collab upgrade', () => {
  it('bad Origin upgrade is refused', async () => {
    for (const headers of [{ Origin: 'https://evil.test' }, {}]) {
      const ws = new WebSocket(url, { headers })
      const outcome = await new Promise<string>((resolve) => {
        ws.on('open', () => resolve('open'))
        ws.on('unexpected-response', () => resolve('refused'))
        ws.on('error', () => resolve('refused'))
      })
      ws.terminate()
      expect(outcome).toBe('refused')
    }
  })

  it('an upgrade to any other path is closed promptly', async () => {
    const ws = new WebSocket(url.replace('/collab', '/nope'), { headers: { Origin: ORIGIN } })
    const started = Date.now()
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('unexpected-response', () => resolve('refused'))
      ws.on('error', () => resolve('refused'))
    })
    ws.terminate()
    expect(outcome).toBe('refused')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('an unauthenticated connection is denied and its socket closed', async () => {
    const closed: number[] = []
    const c = connect('')
    c.socket.on('close', ({ event }: { event: { code: number } }) => closed.push(event.code))
    await waitFor(() => c.failures.length > 0 && closed.length > 0)
    expect(c.failures[0]).toBe('unauthorized')
  })

  it('an unauthenticated connection is denied', async () => {
    const c = connect('')
    await waitFor(() => c.failures.length > 0)
    expect(c.failures[0]).toBe('unauthorized')
  })
})

describe('collab document sync', () => {
  it('seeds from the project and an editor edit reaches a second client', async () => {
    const owner = await connectSynced(await ownerCookie())
    expect(lineText(owner.doc, 'l1')).toBe('one')
    expect(owner.doc.getMap('meta').get('title')).toBe('Song')
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'uno')
    await waitFor(() => lineText(owner.doc, 'l1') === 'uno')
  })

  it("viewer's local edit never reaches the editor", async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const viewer = await connectSynced(guest('vw', viewerInvite))
    expect(viewer.provider.authorizedScope).toBe('readonly')
    viewer.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'hacked')
    // A later editor write that does reach the viewer proves the pipe is flowing.
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l2')!.set('text', 'dos')
    await waitFor(() => lineText(viewer.doc, 'l2') === 'dos')
    await new Promise((r) => setTimeout(r, 200))
    expect(lineText(editor.doc, 'l1')).toBe('one')
  })

  it('doc survives all clients leaving and store projects into Lyrics.sections', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l2')!.set('text', 'persisted')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => {
      const l = await Lyrics.findOne({ publicId: PUBLIC_ID }).lean()
      return l?.sections?.[0]?.lines?.[1]?.text === 'persisted'
    })
    const lyrics = await Lyrics.findOne({ publicId: PUBLIC_ID }).lean()
    expect(lyrics!.version).toBeGreaterThan(1)
    expect(lyrics!.sections[0].lines.map((l) => l.id)).toEqual(['l1', 'l2'])
    const project = await Project.findOne({ publicId: PUBLIC_ID }).lean()
    expect(project!.contentUpdatedAt).toBeInstanceOf(Date)
    expect(await CollabDoc.exists({ name: DOC })).toBeTruthy()

    const fresh = await connectSynced(await ownerCookie())
    expect(lineText(fresh.doc, 'l2')).toBe('persisted')
  })
})

describe('collab staleness', () => {
  it('a stored doc is re-seeded when Lyrics changed outside the session', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'collab')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())?.sections?.[0]?.lines?.[0]?.text === 'collab')
    await new Promise((r) => setTimeout(r, 150))
    await Lyrics.updateOne({ publicId: PUBLIC_ID }, { $set: { 'sections.0.lines.0.text': 'solo' }, $inc: { version: 1 } })
    const fresh = await connectSynced(await ownerCookie())
    expect(lineText(fresh.doc, 'l1')).toBe('solo')
  })
})

describe('collab lock protocol', () => {
  it('two simultaneous lock requests → exactly one holder in the snapshot', async () => {
    const owner = await connectSynced(await ownerCookie())
    const editor = await connectSynced(guest('ed', editorInvite))
    owner.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l1' }))
    editor.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l1' }))
    await waitFor(() => [owner, editor].some((c) => c.stateless.some((m) => m.t === 'lock-denied')))
    await waitFor(() => !!lastLocks(owner)?.l1 && !!lastLocks(editor)?.l1)
    expect(Object.keys(lastLocks(owner)!)).toEqual(['l1'])
    expect(lastLocks(owner)).toEqual(lastLocks(editor))
    const denied = [owner, editor].filter((c) => c.stateless.some((m) => m.t === 'lock-denied'))
    expect(denied).toHaveLength(1)
  })

  it('closing the holder\'s socket frees its locks', async () => {
    const owner = await connectSynced(await ownerCookie())
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l2' }))
    await waitFor(() => lastLocks(owner)?.l2?.subject === 'guest:ed')
    close(editor)
    await waitFor(() => !!lastLocks(owner) && !lastLocks(owner)!.l2)
  })

  it('heartbeat for a line held by someone else is denied; force-unlock is owner-only', async () => {
    const owner = await connectSynced(await ownerCookie())
    const editor = await connectSynced(guest('ed', editorInvite))
    owner.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l1' }))
    await waitFor(() => lastLocks(editor)?.l1?.subject === `user:${ownerId}`)
    editor.provider.sendStateless(JSON.stringify({ t: 'heartbeat', lineIds: ['l1'] }))
    editor.provider.sendStateless(JSON.stringify({ t: 'force-unlock', lineId: 'l1' }))
    await waitFor(() => editor.stateless.some((m) => m.t === 'lock-denied' && m.lineId === 'l1'))
    await new Promise((r) => setTimeout(r, 150))
    expect(lastLocks(owner)?.l1?.subject).toBe(`user:${ownerId}`)

    editor.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l2' }))
    await waitFor(() => lastLocks(owner)?.l2?.subject === 'guest:ed')
    owner.provider.sendStateless(JSON.stringify({ t: 'force-unlock', lineId: 'l2' }))
    await waitFor(() => !!lastLocks(editor) && !lastLocks(editor)!.l2)
  })

  it('viewers cannot take locks', async () => {
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    viewer.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l1' }))
    await waitFor(() => viewer.stateless.some((m) => m.t === 'lock-denied'))
    expect(lastLocks(owner)?.l1).toBeUndefined()
  })
})

describe('collab moderation hooks', () => {
  it('endSession notifies, closes, stores, and the session refuses reconnects', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'final')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    await CollabSession.updateOne({ _id: sessionId }, { $set: { endedAt: new Date() } })
    await getCollabServer().endSession(DOC)
    expect(editor.stateless.some((m) => m.t === 'session-ended')).toBe(true)
    const lyrics = await Lyrics.findOne({ publicId: PUBLIC_ID }).lean()
    expect(lyrics!.sections[0].lines[0].text).toBe('final')
    await waitFor(() => editor.failures.includes('session_ended'))
  })

  it('reconnectSubject makes a demoted member reconnect read-only', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    expect(editor.provider.authorizedScope).toBe('read-write')
    await CollabSession.updateOne({ _id: sessionId, 'members.subject': 'guest:ed' }, { $set: { 'members.$.role': 'viewer' } })
    getCollabServer().reconnectSubject(DOC, 'guest:ed')
    await waitFor(() => editor.provider.authorizedScope === 'readonly')
  })

  it('closeSubject drops that subject and its locks', async () => {
    const owner = await connectSynced(await ownerCookie())
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l1' }))
    await waitFor(() => lastLocks(owner)?.l1?.subject === 'guest:ed')
    await CollabSession.updateOne({ _id: sessionId }, { $push: { kicked: 'guest:ed' } })
    getCollabServer().closeSubject(DOC, 'guest:ed')
    await waitFor(() => !!lastLocks(owner) && !lastLocks(owner)!.l1)
    await waitFor(() => editor.failures.includes('forbidden'))
  })
})
