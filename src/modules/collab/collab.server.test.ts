import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import WebSocket from 'ws'
import net from 'net'
import { vi } from 'vitest'
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
import { removeProjectCollaborator } from './collab.service.js'

// Lets a test hold the server's disconnect-time awareness removal, to stand in for a peer whose
// connection is gone but whose state the server has not cleaned up yet.
const awarenessGate = vi.hoisted(() => ({ hold: false, held: [] as Array<() => void> }))
vi.mock('y-protocols/awareness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('y-protocols/awareness')>()
  return {
    ...actual,
    removeAwarenessStates: (...args: Parameters<typeof actual.removeAwarenessStates>) => {
      if (awarenessGate.hold) awarenessGate.held.push(() => actual.removeAwarenessStates(...args))
      else actual.removeAwarenessStates(...args)
    },
  }
})

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

function connect(cookie: string, clientId?: number): Client {
  const headers = { Origin: ORIGIN, Cookie: cookie }
  class HeaderedWebSocket extends WebSocket {
    constructor(address: string) {
      super(address, { headers })
    }
  }
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: HeaderedWebSocket, delay: 50, minDelay: 50 })
  const doc = new Y.Doc()
  if (clientId !== undefined) doc.clientID = clientId
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

async function connectSynced(cookie: string, clientId?: number): Promise<Client> {
  const c = connect(cookie, clientId)
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
  // Loose admission limits: this file opens many sockets from one IP. Small doc cap keeps the size test fast.
  await app.register(collabPlugin, { upgradesPerMinute: 10_000, maxConnectionsPerIp: 1_000, maxDocBytes: 100_000 })
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
  awarenessGate.hold = false
  awarenessGate.held.length = 0
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

})

function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(raw))
    let data = ''
    sock.on('data', (d) => { data += d.toString() })
    sock.on('close', () => resolve(data))
    sock.on('error', () => resolve(data))
    setTimeout(() => sock.destroy(), 2000)
  })
}

describe('collab upgrade hardening', () => {
  it('malformed upgrade targets are refused without crashing the server', async () => {
    const port = (app.server.address() as { port: number }).port
    for (const target of ['//', '///', '//:99999/']) {
      const res = await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`)
      expect(res).toMatch(/^HTTP\/1\.1 404/)
    }
    // Still alive and serving.
    const owner = await connectSynced(await ownerCookie())
    expect(lineText(owner.doc, 'l1')).toBe('one')
  })

  it('caps concurrent sockets and upgrade rate per IP', async () => {
    const limited = Fastify()
    await limited.register(collabPlugin, { upgradesPerMinute: 3, maxConnectionsPerIp: 2 })
    await limited.listen({ port: 0, host: '127.0.0.1' })
    const lurl = `ws://127.0.0.1:${(limited.server.address() as { port: number }).port}/collab`
    const attempt = () => new Promise<{ ws: WebSocket; status: number }>((resolve) => {
      const ws = new WebSocket(lurl, { headers: { Origin: ORIGIN } })
      ws.on('open', () => resolve({ ws, status: 101 }))
      ws.on('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode ?? 0 }))
      ws.on('error', () => resolve({ ws, status: 0 }))
    })
    try {
      const a = await attempt()
      const b = await attempt()
      const c = await attempt()
      expect([a.status, b.status, c.status]).toEqual([101, 101, 429]) // concurrent cap
      a.ws.close()
      await new Promise((r) => setTimeout(r, 100))
      const d = await attempt() // a slot freed up; spends the 3rd and last token
      expect(d.status).toBe(101)
      b.ws.close()
      d.ws.close()
      await new Promise((r) => setTimeout(r, 100))
      const e = await attempt() // slots free, bucket empty
      expect(e.status).toBe(429)
      for (const x of [a, b, c, d, e]) x.ws.terminate()
    } finally {
      await limited.close()
    }
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

describe('collab persistence hardening', () => {
  it('a doc past the size cap drops the writer and turns read-only, and still persists', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'y'.repeat(150_000))
    await waitFor(() => editor.provider.authorizedScope === 'readonly')
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l2')!.set('text', 'after-cap')
    const owner = await connectSynced(await ownerCookie())
    expect(owner.provider.authorizedScope).toBe('readonly')
    await new Promise((r) => setTimeout(r, 200))
    expect(lineText(owner.doc, 'l2')).toBe('two')
    for (const c of open.splice(0)) close(c)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text.length === 2000)
    // The read-only mark outlives unloads by design; ending the session is what clears it.
    await getCollabServer().endSession(DOC)
  })

  it('malformed client values are sanitised so the Lyrics projection still lands', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.transact(() => {
      const l1 = editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!
      l1.set('text', 'z'.repeat(2500))
      l1.set('words', 'not-an-array')
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l2')!.set('id', 'i'.repeat(55))
      editor.doc.getMap('meta').set('editorMode', 'bogus')
    })
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.version > 1)
    const lyrics = await Lyrics.findOne({ publicId: PUBLIC_ID }).lean()
    expect(lyrics!.editorMode).toBe('lrc')
    expect(lyrics!.sections[0].lines[0].text).toHaveLength(2000)
    expect(lyrics!.sections[0].lines[1].id).toBeNull()
  })

  it('a failed store keeps the doc in memory and a later store persists it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const editor = await connectSynced(guest('ed', editorInvite))
      const spy = vi.spyOn(CollabDoc, 'updateOne').mockRejectedValueOnce(new Error('boom'))
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'kept')
      await waitFor(() => !editor.provider.hasUnsyncedChanges)
      close(editor)
      await waitFor(() => spy.mock.calls.length > 0)
      spy.mockRestore()
      const again = await connectSynced(guest('ed', editorInvite))
      expect(lineText(again.doc, 'l1')).toBe('kept')
      again.doc.getMap<Y.Map<unknown>>('lines').get('l2')!.set('text', 'later')
      await waitFor(() => !again.provider.hasUnsyncedChanges)
      close(again)
      await waitFor(async () => {
        const l = await Lyrics.findOne({ publicId: PUBLIC_ID }).lean()
        return l!.sections[0].lines[0].text === 'kept' && l!.sections[0].lines[1].text === 'later'
      })
    } finally {
      errors.mockRestore()
    }
  })

  it('a crash after the state write but before the Lyrics write keeps the doc', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'newest')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text === 'newest')
    await new Promise((r) => setTimeout(r, 150))
    // Roll Lyrics back to what it held before the projection, as if the process died between the writes.
    await Lyrics.updateOne({ publicId: PUBLIC_ID }, { $set: { 'sections.0.lines.0.text': 'one' }, $inc: { version: -1 } })
    const fresh = await connectSynced(await ownerCookie())
    expect(lineText(fresh.doc, 'l1')).toBe('newest')
  })
})

describe('collab version bookkeeping', () => {
  it('a failed Lyrics write followed by a solo save re-seeds with the solo content', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const spy = vi.spyOn(Lyrics, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('projection down')
    })
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'collab')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(() => spy.mock.calls.length > 0)
    spy.mockRestore()
    await new Promise((r) => setTimeout(r, 150))
    // The owner saves solo while the projection is behind.
    await Lyrics.updateOne({ publicId: PUBLIC_ID }, { $set: { 'sections.0.lines.0.text': 'solo' }, $inc: { version: 1 } })
    const fresh = await connectSynced(await ownerCookie())
    expect(lineText(fresh.doc, 'l1')).toBe('solo')
  })

  it('a crash after the Lyrics write but before the lyricsVersion write keeps the doc and its Yjs items', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'collab')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => {
      const [l, d] = await Promise.all([Lyrics.findOne({ publicId: PUBLIC_ID }).lean(), CollabDoc.findOne({ name: DOC }).lean()])
      return l!.sections[0].lines[0].text === 'collab' && d?.lyricsVersion === l!.version
    })
    await new Promise((r) => setTimeout(r, 150))
    const lyrics = await Lyrics.findOne({ publicId: PUBLIC_ID }).lean()
    // As if the process died before recording the version Lyrics reached.
    await CollabDoc.updateOne({ name: DOC }, { $set: { lyricsVersion: lyrics!.version - 1 } })
    const before = (await CollabDoc.findOne({ name: DOC }))!.state
    const fresh = await connectSynced(await ownerCookie())
    expect(lineText(fresh.doc, 'l1')).toBe('collab')
    const after = await CollabDoc.findOne({ name: DOC })
    expect(Buffer.compare(after!.state, before)).toBe(0) // no re-seed: same Yjs items
    expect(after!.lyricsVersion).toBe(lyrics!.version)
  })

  it('a writer already connected when the doc freezes cannot add more', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'y'.repeat(150_000))
    await waitFor(() => editor.provider.authorizedScope === 'readonly')
    owner.doc.getMap<Y.Map<unknown>>('lines').get('l2')!.set('text', 'after-freeze')
    await new Promise((r) => setTimeout(r, 400))
    expect(lineText(viewer.doc, 'l2')).toBe('two')
    for (const c of open.splice(0)) close(c)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text.length === 2000)
    expect((await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[1].text).toBe('two')
    await getCollabServer().endSession(DOC)
  })
})

describe('collab metadata write-back', () => {
  it('meta title and album are written back to the project fields they came from, sanitised', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const meta = editor.doc.getMap('meta')
    editor.doc.transact(() => {
      meta.set('title', '<b>New</b> Song')
      meta.set('album', 'A'.repeat(600))
      meta.set('artist', 'Someone Else')
    })
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => (await Project.findOne({ publicId: PUBLIC_ID }).lean())?.metadata?.songName === 'New Song')
    const p = await Project.findOne({ publicId: PUBLIC_ID }).lean()
    expect(p!.metadata!.songAlbum).toBe('A'.repeat(500))
    // songArtist is derived from structured credits and never written from free text.
    expect(p!.metadata!.songArtist).toBe('Artist')
    expect(p!.title).toBe('T')
    expect(p!.slug).toContain('new-song')
  })

  it('writes the title to Project.title when the seed took it from there', async () => {
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { 'metadata.songName': '' } })
    const editor = await connectSynced(guest('ed', editorInvite))
    expect(editor.doc.getMap('meta').get('title')).toBe('T')
    editor.doc.getMap('meta').set('title', 'Retitled')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => (await Project.findOne({ publicId: PUBLIC_ID }).lean())?.title === 'Retitled')
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.metadata!.songName).toBe('')
  })

  it('a stored doc picks up project metadata changed between sessions', async () => {
    const first = await connectSynced(guest('ed', editorInvite))
    first.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'kept')
    await waitFor(() => !first.provider.hasUnsyncedChanges)
    close(first)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())?.sections?.[0]?.lines?.[0]?.text === 'kept')
    await new Promise((r) => setTimeout(r, 150))
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { 'metadata.songName': 'Renamed Solo', 'metadata.songAlbum': '' } })
    const fresh = await connectSynced(guest('ed', editorInvite))
    expect(fresh.doc.getMap('meta').get('title')).toBe('Renamed Solo')
    expect(fresh.doc.getMap('meta').get('album')).toBe(null)
    expect(lineText(fresh.doc, 'l1')).toBe('kept')
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

describe('collab hello', () => {
  it('greets each connection with its own identity, then the lock snapshot', async () => {
    const owner = await connectSynced(await ownerCookie())
    owner.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'l1' }))
    await waitFor(() => !!lastLocks(owner)?.l1)
    const viewer = await connectSynced(guest('vw', viewerInvite))
    await waitFor(() => owner.stateless.some((m) => m.t === 'hello') && viewer.stateless.some((m) => m.t === 'hello'))
    const helloOf = (c: Client) => c.stateless.find((m) => m.t === 'hello')!
    expect(helloOf(owner)).toMatchObject({ subject: `user:${ownerId}`, role: 'owner' })
    expect(helloOf(viewer)).toMatchObject({ subject: 'guest:vw', name: 'vw', role: 'viewer' })
    expect(helloOf(owner).conn).not.toBe(helloOf(viewer).conn)
    expect(helloOf(viewer).colorIndex).toBeGreaterThanOrEqual(1)
    expect(helloOf(viewer).colorIndex).toBeLessThanOrEqual(8)
    // The joiner sees the owner's existing lock, keyed by the owner's conn, without waiting for a change.
    await waitFor(() => !!lastLocks(viewer)?.l1)
    expect((lastLocks(viewer)!.l1 as { holderConn: string }).holderConn).toBe(helloOf(owner).conn)
    // Each connection is greeted once, and only about itself.
    expect(owner.stateless.filter((m) => m.t === 'hello')).toHaveLength(1)
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

describe('collab awareness identity', () => {
  const states = (c: Client) => c.provider.awareness!.getStates()

  it('stamps the real identity over whatever the client claims', async () => {
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    viewer.provider.awareness!.setLocalState({ user: { name: 'Owner', colorIndex: 1, role: 'owner', subject: `user:${ownerId}` }, pointer: null })
    const id = viewer.doc.clientID
    await waitFor(() => (states(owner).get(id) as { pointer?: unknown } | undefined)?.pointer === null)
    expect(states(owner).get(id)).toMatchObject({ user: { name: 'vw', role: 'viewer', subject: 'guest:vw' } })
  })

  it('keeps the client\'s other fields', async () => {
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    viewer.provider.awareness!.setLocalState({ user: { name: 'x' }, activeLineId: 'l1', duration: 90 })
    await waitFor(() => (states(owner).get(viewer.doc.clientID) as { activeLineId?: string } | undefined)?.activeLineId === 'l1')
    expect(states(owner).get(viewer.doc.clientID)).toMatchObject({ duration: 90 })
  })

  it("a client cannot overwrite or remove another client's awareness id", async () => {
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    // A client applies a forged state for its own id only when the clock is higher, so a third client is the neutral witness of what the server relays.
    const witness = await connectSynced(guest('ed', editorInvite))
    owner.provider.awareness!.setLocalState({ activeLineId: 'real' })
    const target = owner.doc.clientID
    await waitFor(() => (states(witness).get(target) as { activeLineId?: string } | undefined)?.activeLineId === 'real')
    await waitFor(() => (states(viewer).get(target) as { activeLineId?: string } | undefined)?.activeLineId === 'real')
    // Send updates for the owner's clientId over the viewer's own connection.
    const aw = viewer.provider.awareness!
    const send = (change: { updated?: number[]; removed?: number[] }) =>
      (viewer.provider as unknown as { awarenessUpdateHandler: (c: object, o: unknown) => void })
        .awarenessUpdateHandler({ added: [], updated: change.updated ?? [], removed: change.removed ?? [] }, 'test')
    aw.getStates().set(target, { activeLineId: 'forged' })
    aw.meta.set(target, { clock: 1_000_000, lastUpdated: Date.now() })
    send({ updated: [target] })
    aw.getStates().delete(target)
    send({ removed: [target] })
    // A later, legitimate update from the viewer proves the forged ones were processed first.
    aw.setLocalState({ activeLineId: 'marker' })
    await waitFor(() => (states(owner).get(viewer.doc.clientID) as { activeLineId?: string } | undefined)?.activeLineId === 'marker')
    await new Promise((r) => setTimeout(r, 200))
    expect((states(witness).get(target) as { activeLineId?: string } | undefined)?.activeLineId).toBe('real')
  })

  // Sends awareness for an arbitrary clientId over this client's own connection.
  function sendAs(c: Client, clientId: number, state: object | null) {
    const aw = c.provider.awareness!
    if (state) aw.getStates().set(clientId, state)
    else aw.getStates().delete(clientId)
    aw.meta.set(clientId, { clock: (aw.meta.get(clientId)?.clock ?? 0) + 1000, lastUpdated: Date.now() })
    ;(c.provider as unknown as { awarenessUpdateHandler: (ch: object, o: unknown) => void })
      .awarenessUpdateHandler({ added: [], updated: state ? [clientId] : [], removed: state ? [] : [clientId] }, 'test')
  }

  it("removes a peer's awareness for everyone else when it disconnects", async () => {
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    viewer.provider.awareness!.setLocalState({ activeLineId: 'l1' })
    const id = viewer.doc.clientID
    await waitFor(() => states(owner).has(id))
    close(viewer)
    await waitFor(() => !states(owner).has(id))
  })

  it('another subject cannot claim a clientId a disconnected peer used; the same subject can reuse it', async () => {
    const owner = await connectSynced(await ownerCookie())
    const witness = await connectSynced(guest('ed', editorInvite))
    const first = await connectSynced(guest('vw', viewerInvite))
    first.provider.awareness!.setLocalState({ activeLineId: 'a' })
    const id = first.doc.clientID
    await waitFor(() => states(witness).has(id))
    first.socket.disconnect()
    await waitFor(() => !states(witness).has(id))
    // A different subject tries to squat the id.
    sendAs(owner, id, { activeLineId: 'squat' })
    owner.provider.awareness!.setLocalState({ activeLineId: 'marker' })
    await waitFor(() => (states(witness).get(owner.doc.clientID) as { activeLineId?: string } | undefined)?.activeLineId === 'marker')
    expect(states(witness).has(id)).toBe(false)
    // The original subject comes back on a new connection with the same clientId.
    first.socket.connect().catch(() => {})
    await waitFor(() => first.provider.isSynced)
    first.provider.awareness!.setLocalState({ activeLineId: 'back' })
    await waitFor(() => (states(witness).get(id) as { activeLineId?: string } | undefined)?.activeLineId === 'back')
  })

  it('drops a second clientId sent over the same connection', async () => {
    const viewer = await connectSynced(guest('vw', viewerInvite))
    const witness = await connectSynced(guest('ed', editorInvite))
    viewer.provider.awareness!.setLocalState({ activeLineId: 'a' })
    await waitFor(() => states(witness).has(viewer.doc.clientID))
    sendAs(viewer, 424242, { activeLineId: 'extra' })
    viewer.provider.awareness!.setLocalState({ activeLineId: 'marker' })
    await waitFor(() => (states(witness).get(viewer.doc.clientID) as { activeLineId?: string } | undefined)?.activeLineId === 'marker')
    expect(states(witness).has(424242)).toBe(false)
  })

  it('a reconnect with the same clientId leaves no ghost behind when it closes', async () => {
    const witness = await connectSynced(guest('ed', editorInvite))
    const peer = await connectSynced(guest('vw', viewerInvite))
    const id = peer.doc.clientID
    peer.provider.awareness!.setLocalState({ activeLineId: 'a' })
    await waitFor(() => states(witness).has(id))
    peer.socket.disconnect()
    await waitFor(() => !states(witness).has(id))
    // Same id on a new connection arrives as an update, not an add.
    peer.socket.connect().catch(() => {})
    await waitFor(() => peer.provider.isSynced)
    peer.provider.awareness!.setLocalState({ activeLineId: 'b' })
    await waitFor(() => (states(witness).get(id) as { activeLineId?: string } | undefined)?.activeLineId === 'b')
    peer.socket.disconnect()
    await waitFor(() => !states(witness).has(id), 3000)
  })

  it("caps a subject's awareness bindings at 8 and never evicts a live one", async () => {
    const witness = await connectSynced(guest('ed', editorInvite))
    const live: Client[] = []
    for (let i = 0; i < 8; i++) {
      const c = await connectSynced(guest('vw', viewerInvite))
      c.provider.awareness!.setLocalState({ activeLineId: `l${i}` })
      await waitFor(() => states(witness).has(c.doc.clientID))
      live.push(c)
    }
    // A ninth live connection of the same subject has nothing to evict: refused.
    const ninth = await connectSynced(guest('vw', viewerInvite))
    ninth.provider.awareness!.setLocalState({ activeLineId: 'ninth' })
    await new Promise((r) => setTimeout(r, 300))
    expect(states(witness).has(ninth.doc.clientID)).toBe(false)
    // One live connection leaves: its binding is the one that can go, so the ninth is now accepted.
    close(live[0])
    await waitFor(() => !states(witness).has(live[0].doc.clientID))
    ninth.provider.awareness!.setLocalState({ activeLineId: 'ninth-again' })
    await waitFor(() => states(witness).has(ninth.doc.clientID))
    for (const c of live.slice(1)) expect(states(witness).has(c.doc.clientID)).toBe(true)
  })

  // A binding of subject 'vw' whose connection is gone but whose state the server still holds
  // (the disconnect-time removal is held back). Reconnecting first makes the id arrive as an
  // update, so Hocuspocus does not remove it on close either; only our onDisconnect would.
  async function ghostBinding(witness: Client, i: number): Promise<number> {
    const c = await connectSynced(guest('vw', viewerInvite))
    const id = c.doc.clientID
    c.provider.awareness!.setLocalState({ activeLineId: `g${i}` })
    await waitFor(() => states(witness).has(id))
    c.socket.disconnect()
    await waitFor(() => !states(witness).has(id))
    c.socket.connect().catch(() => {})
    await waitFor(() => c.provider.isSynced)
    c.provider.awareness!.setLocalState({ activeLineId: `g${i}b` })
    await waitFor(() => (states(witness).get(id) as { activeLineId?: string } | undefined)?.activeLineId === `g${i}b`)
    const before = awarenessGate.held.length
    awarenessGate.hold = true
    c.socket.disconnect()
    await waitFor(() => awarenessGate.held.length === before + 1)
    awarenessGate.hold = false
    return id
  }

  it('at the cap, does not evict a binding whose state is still present', async () => {
    const witness = await connectSynced(guest('ed', editorInvite))
    const ghosts: number[] = []
    for (let i = 0; i < 8; i++) ghosts.push(await ghostBinding(witness, i))
    const ninth = await connectSynced(guest('vw', viewerInvite))
    ninth.provider.awareness!.setLocalState({ activeLineId: 'ninth' })
    await new Promise((r) => setTimeout(r, 300))
    expect(states(witness).has(ninth.doc.clientID)).toBe(false)
    for (const id of ghosts) expect(states(witness).has(id)).toBe(true)
  })

  it('at the cap, evicts a non-live binding once its state is gone, and only that one', async () => {
    const witness = await connectSynced(guest('ed', editorInvite))
    const ghosts: number[] = []
    for (let i = 0; i < 8; i++) ghosts.push(await ghostBinding(witness, i))
    // The oldest ghost's disconnect cleanup runs; the others are still pending.
    awarenessGate.held[0]()
    await waitFor(() => !states(witness).has(ghosts[0]))
    const ninth = await connectSynced(guest('vw', viewerInvite))
    ninth.provider.awareness!.setLocalState({ activeLineId: 'ninth' })
    await waitFor(() => states(witness).has(ninth.doc.clientID))
    // The evicted id is free for another subject; a ghost that still has state is not.
    // (sendAs jumps the clock past the server's, which a fresh client with a reused id would not do.)
    const claimer = await connectSynced(await ownerCookie(), ghosts[0])
    sendAs(claimer, ghosts[0], { activeLineId: 'claimed' })
    await waitFor(() => (states(witness).get(ghosts[0]) as { user?: { subject?: string } } | undefined)?.user?.subject === `user:${ownerId}`)
    const squatter = await connectSynced(await ownerCookie(), ghosts[1])
    sendAs(squatter, ghosts[1], { activeLineId: 'squat' })
    await new Promise((r) => setTimeout(r, 300))
    expect(states(witness).get(ghosts[1])).toMatchObject({ activeLineId: 'g1b', user: { subject: 'guest:vw' } })
  })
})

describe('collab credits', () => {
  const credits = async () => ((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.collaborators ?? [])
  const edit = (c: Client, id = 'l1', text = 'x') => c.doc.getMap<Y.Map<unknown>>('lines').get(id)!.set('text', text)
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms))

  it('credits a guest editor once, by the name they typed, however many changes they make', async () => {
    const ed = await connectSynced(guest('ed', editorInvite))
    edit(ed, 'l1', 'a')
    edit(ed, 'l2', 'b')
    await waitFor(async () => (await credits()).length === 1)
    edit(ed, 'l1', 'c')
    await settle()
    const list = await credits()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ subject: 'guest:ed', userId: null, guestName: 'ed' })
  })

  it('credits a signed-in editor by userId', async () => {
    const u = await User.collection.insertOne({
      accountName: 'editor1', displayName: 'Editor One', email: 'e@x.test', passwordHash: 'x',
      isDeleted: false, role: 'user', permissions: [], ban: { active: false },
    })
    const id = u.insertedId.toString()
    await CollabSession.updateOne({ publicId: PUBLIC_ID }, { $push: { members: { subject: `user:${id}`, role: 'editor', colorIndex: 2, name: 'Editor One' } } })
    const familyId = `fam-${id}`
    await Session.create({ userId: id, familyId, refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 3600_000) })
    const ed = await connectSynced(`accessToken=${jwtTools.signAccess({ sub: id, familyId })}`)
    edit(ed)
    await waitFor(async () => (await credits()).length === 1)
    const [c] = await credits()
    expect(c.subject).toBe(`user:${id}`)
    expect(String(c.userId)).toBe(id)
    expect(c.guestName).toBeNull()
  })

  it('never credits the owner, a viewer, or someone who only joined', async () => {
    const owner = await connectSynced(await ownerCookie())
    const viewer = await connectSynced(guest('vw', viewerInvite))
    await connectSynced(guest('lurker', editorInvite))
    edit(owner, 'l1', 'owner edit')
    edit(viewer, 'l2', 'viewer edit')
    await waitFor(() => lineText(viewer.doc, 'l1') === 'owner edit')
    await settle()
    expect(await credits()).toHaveLength(0)
  })

  it('does not re-add a subject the owner removed, even in the same live session', async () => {
    const ed = await connectSynced(guest('ed', editorInvite))
    const later = await connectSynced(guest('later', editorInvite))
    edit(ed, 'l1', 'a')
    edit(later, 'l2', 'z')
    await waitFor(async () => (await credits()).length === 2)

    await removeProjectCollaborator(PUBLIC_ID, 'guest:ed', ownerId)
    await removeProjectCollaborator(PUBLIC_ID, 'guest:later', ownerId)
    expect(await credits()).toHaveLength(0)

    edit(ed, 'l1', 'b')
    edit(later, 'l2', 'c')
    // A subject that was never removed proves the hook is still alive.
    const other = await connectSynced(guest('other', editorInvite))
    edit(other, 'l1', 'd')
    await waitFor(async () => (await credits()).length === 1)
    await settle()
    expect((await credits()).map((c) => c.subject)).toEqual(['guest:other'])
    const project = await Project.findOne({ publicId: PUBLIC_ID }).lean()
    expect([...project!.removedCollaborators].sort()).toEqual(['guest:ed', 'guest:later'])
  })

  it('does not credit an editor whose connection is read-only (doc frozen at the size cap)', async () => {
    const big = await connectSynced(guest('big', editorInvite))
    edit(big, 'l1', 'y'.repeat(150_000))
    await waitFor(() => big.provider.authorizedScope === 'readonly')
    const late = await connectSynced(guest('late', editorInvite))
    expect(late.provider.authorizedScope).toBe('readonly')
    edit(late, 'l2', 'nope')
    await settle()
    expect((await credits()).map((c) => c.subject)).not.toContain('guest:late')
    await getCollabServer().endSession(DOC)
  })
})
