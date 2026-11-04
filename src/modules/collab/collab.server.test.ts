import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
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
import { resolvePrincipal, signGuestToken } from './collab.auth.js'
import Upload from '../uploads/upload.model.js'
import { loadEnv } from '../../config/env.js'
import { getCollabServer } from './collab.server.js'
import {
  createInvite, endIdleSessions, endSession, getSessionView, hashInviteToken, joinSession, kick, removeProjectCollaborator, startSession,
} from './collab.service.js'
import { collabSessionBlocks, deleteProjectAsModerator } from '../projects/projects.crud.service.js'
import { deactivateUser, logout, revokeAllSessions, revokeSession } from '../auth/auth.service.js'
import { changePasswordAtomically } from '../auth/auth.tx.service.js'
import { blockIp, deleteUser, toggleBan } from '../admin/admin.service.js'
import BannedIp from '../admin/banned-ip.model.js'
import { archiveDeletedUsers } from '../../jobs/archive-deleted-users.js'

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

let mongo: MongoMemoryReplSet
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

function connect(cookie: string, clientId?: number, opts: { url?: string; parameters?: Record<string, string> } = {}): Client {
  const headers = { Origin: ORIGIN, Cookie: cookie }
  class HeaderedWebSocket extends WebSocket {
    constructor(address: string) {
      super(address, { headers })
      this.on('error', () => {})
    }
  }
  // The provider has no parameters option: query params travel on the URL, as the client sends deviceId.
  const query = opts.parameters ? `?${new URLSearchParams(opts.parameters)}` : ''
  const socket = new HocuspocusProviderWebsocket({
    url: `${opts.url ?? url}${query}`, WebSocketPolyfill: HeaderedWebSocket, delay: 50, minDelay: 50,
  })
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
  try { c.provider.destroy() } catch { /* ignore */ }
  try { c.socket.destroy() } catch { /* ignore */ }
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
  // A replica set: deleting a project and resetting a password run in transactions.
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(mongo.getUri())
  app = Fastify()
  // Loose admission limits: this file opens many sockets from one IP. Small doc cap keeps the size test fast.
  await app.register(collabPlugin, { upgradesPerMinute: 10_000, maxConnectionsPerIp: 1_000, maxDocBytes: 100_000, storeRetryMs: 100 })
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
    // The Project write comes after the Lyrics write the wait above saw.
    await waitFor(async () => (await Project.findOne({ publicId: PUBLIC_ID }).lean())!.contentUpdatedAt instanceof Date)
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

  it('an album the doc holds as null or not at all leaves the stored album alone', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const meta = editor.doc.getMap('meta')
    editor.doc.transact(() => {
      meta.set('album', null)
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'stored')
    })
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())?.sections?.[0]?.lines?.[0]?.text === 'stored')
    await waitFor(async () => (await Project.findOne({ publicId: PUBLIC_ID }).lean())!.version! > 1)
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.metadata!.songAlbum).toBe('Album')
    editor.doc.transact(() => {
      meta.delete('album')
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'stored again')
    })
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())?.sections?.[0]?.lines?.[0]?.text === 'stored again')
    await waitFor(async () => (await Project.findOne({ publicId: PUBLIC_ID }).lean())!.version! > 2)
    expect((await Project.findOne({ publicId: PUBLIC_ID }).lean())!.metadata!.songAlbum).toBe('Album')
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
    await waitFor(() => owner.stateless.some((m) => m.t === 'kicked' && m.subject === 'guest:ed'))
    await waitFor(() => !owner.provider.awareness!.getStates().has(editor.doc.clientID))
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

describe('collab project deletion', () => {
  it('closes live connections without storing, removes the stored doc and ends the session', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const closes: number[] = []
    editor.socket.on('close', ({ event }: { event: { code: number } }) => closes.push(event.code))
    await waitFor(async () => !!(await CollabDoc.exists({ name: DOC })))
    // An edit still inside the store debounce when the delete lands.
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'after delete')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)

    expect(await deleteProjectAsModerator(PUBLIC_ID, ownerId)).toBe(true)

    await waitFor(() => closes.includes(4410))
    expect(editor.stateless.some((m) => m.t === 'session-ended')).toBe(true)
    expect(await CollabSession.exists({ publicId: PUBLIC_ID, endedAt: null })).toBeNull()
    // Past every debounce: nothing wrote the doc or the lyrics back.
    await new Promise((r) => setTimeout(r, 2300))
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()
    expect(await Lyrics.exists({ publicId: PUBLIC_ID })).toBeNull()
    await waitFor(() => editor.failures.includes('session_ended'))
  })

  it('a deleted project with no live connections leaves no stored doc to serve', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    close(editor)
    await new Promise((r) => setTimeout(r, 150))
    expect(await CollabDoc.exists({ name: DOC })).not.toBeNull()
    await deleteProjectAsModerator(PUBLIC_ID, ownerId)
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()
  })

  /** Leaves a stored doc behind with nothing loaded. */
  async function storedDocOnly(): Promise<void> {
    const editor = await connectSynced(guest('ed', editorInvite))
    close(editor)
    await new Promise((r) => setTimeout(r, 150))
    expect(await CollabDoc.exists({ name: DOC })).not.toBeNull()
  }

  /** Holds the next CollabDoc.findOne (the read a load starts with) until release. */
  function holdNextDocRead() {
    const real = CollabDoc.findOne.bind(CollabDoc) as (filter: unknown) => unknown
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const spy = vi.spyOn(CollabDoc, 'findOne').mockImplementationOnce(((filter: unknown) => gate.then(() => real(filter))) as never)
    return { spy, release }
  }

  const neverServed = (c: Client) => {
    expect(c.provider.isSynced).toBe(false)
    expect(c.doc.getMap('lines').size).toBe(0)
  }

  it('a connect while the stored doc is being deleted is refused, with no doc loaded', async () => {
    await storedDocOnly()
    const real = CollabDoc.deleteOne.bind(CollabDoc) as (filter: unknown) => unknown
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const spy = vi.spyOn(CollabDoc, 'deleteOne').mockImplementationOnce(((filter: unknown) => gate.then(() => real(filter))) as never)
    const deleting = deleteProjectAsModerator(PUBLIC_ID, ownerId)
    await waitFor(() => spy.mock.calls.length > 0)
    spy.mockRestore()
    // Get past the session check, so only the tombstone stands between this client and the stored state.
    await CollabSession.create({ publicId: PUBLIC_ID, ownerId })
    const racer = connect(await ownerCookie())
    // The connection waits for the discard, and is refused once it finishes: the project is gone.
    await new Promise((r) => setTimeout(r, 300))
    neverServed(racer)
    release()
    await deleting
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()
    await waitFor(() => racer.failures.length > 0)
    expect(racer.failures[0]).toBe('session_ended')
    neverServed(racer)
  })

  it('a load in flight when the delete lands never serves the content or rewrites the doc', async () => {
    await storedDocOnly()
    const { spy, release } = holdNextDocRead()
    const racer = connect(await ownerCookie())
    await waitFor(() => spy.mock.calls.length > 0)
    const deleting = deleteProjectAsModerator(PUBLIC_ID, ownerId)
    await new Promise((r) => setTimeout(r, 100))
    release()
    await deleting
    spy.mockRestore()
    await waitFor(() => racer.failures.length > 0)
    expect(racer.failures[0]).toBe('session_ended')
    neverServed(racer)
    await new Promise((r) => setTimeout(r, 200))
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()
  })

  it('a stored doc is not served once its project is gone, even with a session still live', async () => {
    await storedDocOnly()
    await Project.deleteOne({ publicId: PUBLIC_ID })
    const racer = connect(await ownerCookie())
    const closes: number[] = []
    racer.socket.on('close', ({ event }: { event: { code: number } }) => closes.push(event.code))
    await waitFor(() => racer.failures.length > 0 && closes.length > 0)
    expect(racer.failures[0]).toBe('session_ended')
    expect(closes[0]).toBe(4410)
    neverServed(racer)
  })

  it('a stored doc is not served once the session ended during the load', async () => {
    await storedDocOnly()
    const { spy, release } = holdNextDocRead()
    const racer = connect(await ownerCookie())
    await waitFor(() => spy.mock.calls.length > 0)
    await CollabSession.updateOne({ _id: sessionId }, { $set: { endedAt: new Date() } })
    release()
    spy.mockRestore()
    await waitFor(() => racer.failures.length > 0)
    neverServed(racer)
  })

  it('the tombstone is cleared afterwards, so it stays bounded and blocks nothing else', async () => {
    await storedDocOnly()
    await deleteProjectAsModerator(PUBLIC_ID, ownerId)
    // Same name again, as a stand-in for a tombstone left behind: a fresh project under it loads normally.
    await Project.collection.insertOne({ publicId: PUBLIC_ID, userId: new mongoose.Types.ObjectId(ownerId), title: 'T', slug: 't', version: 1 })
    await Lyrics.collection.insertOne({
      publicId: PUBLIC_ID, editorMode: 'lrc', version: 1,
      sections: [{ label: null, id: null, depth: null, timestamp: null, lines: [{ id: 'l9', text: 'nine' }] }],
    })
    await CollabSession.create({ publicId: PUBLIC_ID, ownerId })
    const fresh = await connectSynced(await ownerCookie())
    expect(lineText(fresh.doc, 'l9')).toBe('nine')
  })
})

describe('collab account deletion', () => {
  async function liveEdit(): Promise<Client> {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'kept')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    return editor
  }
  const isLive = () => CollabSession.exists({ publicId: PUBLIC_ID, endedAt: null })
  const firstLine = async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text

  // The project outlives the account (a deactivated account can come back), so the session's edits are kept.
  it("deactivating the owner's account ends their session and keeps its edits", async () => {
    const editor = await liveEdit()
    await deactivateUser(ownerId)
    expect(await isLive()).toBeNull()
    expect(editor.stateless.some((m) => m.t === 'session-ended')).toBe(true)
    expect(await firstLine()).toBe('kept')
  })

  it("an admin deleting the owner's account ends their session", async () => {
    const admin = await User.collection.insertOne({
      accountName: 'admin1', email: 'a@x.test', passwordHash: 'x', isDeleted: false, role: 'superadmin', permissions: [], ban: { active: false },
    })
    const editor = await liveEdit()
    await deleteUser(ownerId, admin.insertedId.toString())
    expect(await isLive()).toBeNull()
    expect(editor.stateless.some((m) => m.t === 'session-ended')).toBe(true)
  })

  it('the archive job ends any session still live on an archived account', async () => {
    await User.updateOne({ _id: ownerId }, { $set: { isDeleted: true, deletedAt: new Date(Date.now() - 91 * 86_400_000) } })
    await archiveDeletedUsers()
    expect(await User.exists({ _id: ownerId })).toBeNull()
    expect(await isLive()).toBeNull()
  })
})

describe('collab store retry', () => {
  const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('a store that fails mid-session is retried, and the doc outlives the last client until it lands', async () => {
    const errors = quietly()
    try {
      const editor = await connectSynced(guest('ed', editorInvite))
      const spy = vi.spyOn(CollabDoc, 'updateOne').mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom'))
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'survives')
      await waitFor(() => !editor.provider.hasUnsyncedChanges)
      // The debounced store fails while the client is still here; nothing is pending when it leaves.
      await waitFor(() => spy.mock.calls.length >= 1)
      close(editor)
      await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text === 'survives')
      spy.mockRestore()
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array((await CollabDoc.findOne({ name: DOC }))!.state))
      expect(lineText(doc, 'l1')).toBe('survives')
    } finally {
      errors.mockRestore()
    }
  })

  it('a projection that fails mid-session is retried while the doc is loaded', async () => {
    const errors = quietly()
    try {
      const editor = await connectSynced(guest('ed', editorInvite))
      const spy = vi.spyOn(Lyrics, 'findOneAndUpdate').mockImplementationOnce(() => {
        throw new Error('projection down')
      })
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'projected')
      await waitFor(() => spy.mock.calls.length >= 1)
      spy.mockRestore()
      await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text === 'projected')
    } finally {
      errors.mockRestore()
    }
  })

  it('shutdown gives up on a store that keeps failing within its time bound', async () => {
    const errors = quietly()
    const second = Fastify()
    await second.register(collabPlugin, { upgradesPerMinute: 10_000, maxConnectionsPerIp: 1_000, storeRetryMs: 50, destroyTimeoutMs: 300 })
    await second.listen({ port: 0, host: '127.0.0.1' })
    const port = (second.server.address() as { port: number }).port
    const spy = vi.spyOn(CollabDoc, 'updateOne')
    try {
      const editor = await connectSynced(guest('ed', editorInvite), undefined, { url: `ws://127.0.0.1:${port}/collab` })
      spy.mockRejectedValue(new Error('down'))
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'stuck')
      await waitFor(() => !editor.provider.hasUnsyncedChanges)
      close(editor)
      await new Promise((r) => setTimeout(r, 100))
      const started = Date.now()
      await second.close()
      expect(Date.now() - started).toBeLessThan(2000)
      expect(spy.mock.calls.length).toBeGreaterThan(1)
    } finally {
      spy.mockRestore()
      errors.mockRestore()
    }
  })
})

describe('collab session epoch', () => {
  const closesOf = (c: Client) => {
    const codes: Array<{ code: number; reason: string }> = []
    c.socket.on('close', ({ event }: { event: { code: number; reason: string } }) => codes.push({ code: event.code, reason: event.reason }))
    return codes
  }
  const firstLine = async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text

  it('hello carries the session id', async () => {
    const owner = await connectSynced(await ownerCookie())
    await waitFor(() => owner.stateless.some((m) => m.t === 'hello'))
    expect(owner.stateless.find((m) => m.t === 'hello')!.sessionId).toBe(sessionId)
  })

  it('a tab from an ended session is refused and cannot duplicate lines into the re-seeded doc', async () => {
    const stale = await connectSynced(await ownerCookie())
    stale.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'last edit')
    await waitFor(() => !stale.provider.hasUnsyncedChanges)
    await endSession(PUBLIC_ID, ownerId)
    close(stale)
    expect(await firstLine()).toBe('last edit')
    // The stored doc is gone, so the next session mints new Yjs items from Lyrics.
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()

    await startSession(PUBLIC_ID, ownerId)
    const fresh = await connectSynced(await ownerCookie())
    expect(fresh.doc.getMap('lines').size).toBe(2)
    expect(lineText(fresh.doc, 'l1')).toBe('last edit')

    const back = connect(await ownerCookie(), undefined, { parameters: { sessionId } })
    const closes = closesOf(back)
    await waitFor(() => back.failures.includes('session_ended') && closes.length > 0)
    expect(closes[0]).toEqual({ code: 4410, reason: 'session_ended' })
    expect(fresh.doc.getMap('lines').size).toBe(2)
  })

  it('a matching session id, and no session id at all, are admitted', async () => {
    const matching = await connectSynced(await ownerCookie(), undefined, { parameters: { sessionId } })
    const first = await connectSynced(await ownerCookie())
    expect(matching.failures).toEqual([])
    expect(first.failures).toEqual([])
  })

  it('a stale session id does not add a member', async () => {
    const editor = await connect(guest('stale', editorInvite), undefined, { parameters: { sessionId: 'someoldsession' } })
    await waitFor(() => editor.failures.length > 0)
    expect(editor.failures[0]).toBe('session_ended')
    const s = await CollabSession.findById(sessionId).lean()
    expect(s!.members.some((m) => m.subject === 'guest:stale')).toBe(false)
  })

  it('ending a session with nobody connected still projects a stored doc that is ahead of Lyrics', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const spy = vi.spyOn(Lyrics, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('projection down')
    })
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'only in the doc')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(() => spy.mock.calls.length > 0)
    spy.mockRestore()
    await new Promise((r) => setTimeout(r, 150))
    expect(await firstLine()).toBe('one')

    await endSession(PUBLIC_ID, ownerId)

    expect(await firstLine()).toBe('only in the doc')
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()
  })

  it('a failed final store keeps the doc and the stored state until a retry lands, then removes them', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const editor = await connectSynced(guest('ed', editorInvite))
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'final')
      await waitFor(() => !editor.provider.hasUnsyncedChanges)
      const spy = vi.spyOn(Lyrics, 'findOneAndUpdate')
      spy.mockImplementationOnce(() => {
        throw new Error('projection down')
      })
      await endSession(PUBLIC_ID, ownerId)
      expect(await CollabDoc.exists({ name: DOC })).not.toBeNull()
      spy.mockRestore()
      await waitFor(async () => await firstLine() === 'final')
      await waitFor(async () => !(await CollabDoc.exists({ name: DOC })))
    } finally {
      errors.mockRestore()
    }
  })

  it('a new session reached during a failed final store keeps its doc', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const editor = await connectSynced(guest('ed', editorInvite))
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'final')
      await waitFor(() => !editor.provider.hasUnsyncedChanges)
      const spy = vi.spyOn(Lyrics, 'findOneAndUpdate').mockImplementation(() => {
        throw new Error('projection down')
      })
      await endSession(PUBLIC_ID, ownerId)
      await startSession(PUBLIC_ID, ownerId)
      const fresh = await connectSynced(await ownerCookie())
      expect(lineText(fresh.doc, 'l1')).toBe('final')
      spy.mockRestore()
      await waitFor(async () => await firstLine() === 'final')
      await new Promise((r) => setTimeout(r, 300))
      expect(await CollabDoc.exists({ name: DOC })).not.toBeNull()
      expect(fresh.provider.isSynced).toBe(true)
    } finally {
      errors.mockRestore()
    }
  })

  it('a solo save is refused while a failed final store is still retrying', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const editor = await connectSynced(guest('ed', editorInvite))
      editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'final')
      await waitFor(() => !editor.provider.hasUnsyncedChanges)
      const spy = vi.spyOn(Lyrics, 'findOneAndUpdate').mockImplementation(() => {
        throw new Error('projection down')
      })
      await endSession(PUBLIC_ID, ownerId)
      expect(await collabSessionBlocks(PUBLIC_ID, { lyrics: {} } as never)).toMatchObject({ code: 'collab_active' })
      spy.mockRestore()
      await waitFor(async () => !(await CollabDoc.exists({ name: DOC })))
      expect(await collabSessionBlocks(PUBLIC_ID, { lyrics: {} } as never)).toBeNull()
    } finally {
      errors.mockRestore()
    }
  })
})

describe('collab moderation reaches live sockets', () => {
  let memberId: string
  let adminId: string
  let seq = 0

  async function loginCookie(userId: string, familyId: string): Promise<string> {
    await Session.create({ userId, familyId, refreshTokenHash: `x${seq++}`, expiresAt: new Date(Date.now() + 3600_000) })
    return `accessToken=${jwtTools.signAccess({ sub: userId, familyId })}`
  }
  const closesOf = (c: Client) => {
    const codes: Array<{ code: number; reason: string }> = []
    c.socket.on('close', ({ event }: { event: { code: number; reason: string } }) => codes.push({ code: event.code, reason: event.reason }))
    return codes
  }

  beforeEach(async () => {
    const member = await User.collection.insertOne({
      accountName: 'member1', displayName: 'Member', passwordHash: 'x', isDeleted: false, role: 'user', permissions: [], ban: { active: false }, lastIp: '203.0.113.9',
    })
    memberId = member.insertedId.toString()
    const admin = await User.collection.insertOne({
      accountName: 'admin1', passwordHash: 'x', isDeleted: false, role: 'superadmin', permissions: [], ban: { active: false },
    })
    adminId = admin.insertedId.toString()
    await CollabSession.updateOne({ _id: sessionId }, { $push: { members: { subject: `user:${memberId}`, role: 'editor', colorIndex: 2, name: 'Member' } } })
  })

  describe.each([
    ['deactivating the account', () => deactivateUser(memberId), 'unauthorized'],
    ['an admin deleting the account', () => deleteUser(memberId, adminId), 'unauthorized'],
    ['banning the account', () => toggleBan(memberId, true, 'r', null, false, false, adminId), 'forbidden'],
  ] as const)('%s', (_name, act, refusal) => {
    it("disconnects them from someone else's session and refuses the reconnect; the session carries on", async () => {
      const owner = await connectSynced(await ownerCookie())
      const member = await connectSynced(await loginCookie(memberId, 'fam-a'))
      const closes = closesOf(member)
      await act()
      await waitFor(() => closes.length > 0)
      expect(closes[0]).toEqual({ code: 4403, reason: 'forbidden' })
      await waitFor(() => member.failures.includes(refusal))
      expect(await CollabSession.exists({ _id: sessionId, endedAt: null })).not.toBeNull()
      expect(owner.failures).toEqual([])
    })
  })

  it('also reaches an account connected through a guest cookie', async () => {
    const both = await connectSynced(`${await loginCookie(adminId, 'fam-g')}; ${guest('g1', editorInvite)}`)
    await User.updateOne({ _id: adminId }, { $set: { role: 'user' } })
    const closes = closesOf(both)
    const boss = await User.collection.insertOne({ accountName: 'boss', passwordHash: 'x', isDeleted: false, role: 'superadmin', permissions: [], ban: { active: false } })
    await toggleBan(adminId, true, 'r', null, false, false, boss.insertedId.toString())
    await waitFor(() => closes.length > 0)
    await waitFor(() => both.failures.includes('forbidden'))
  })

  it('a failure closing sockets does not fail the ban', async () => {
    const spy = vi.spyOn(getCollabServer(), 'closeUserEverywhere').mockImplementation(() => {
      throw new Error('boom')
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await toggleBan(memberId, true, 'r', null, false, false, adminId)
      expect(res.success).toBe(true)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      errors.mockRestore()
    }
  })

  it('revoking one login session refuses that connection and the others continue', async () => {
    const revoked = await connectSynced(await loginCookie(memberId, 'fam-a'))
    const other = await connectSynced(await loginCookie(memberId, 'fam-b'))
    const closes = closesOf(other)
    const row = await Session.findOne({ familyId: 'fam-a' })
    await revokeSession(memberId, row!._id.toString())
    await waitFor(() => revoked.failures.includes('unauthorized'))
    await waitFor(() => closes.length > 0)
    expect(closes[0]).toEqual({ code: 4409, reason: 'reauth' })
    await waitFor(() => other.provider.isAuthenticated && other.provider.isSynced)
    expect(other.failures).toEqual([])
  })

  it.each([
    ['logout', () => logout(memberId, 'fam-a')],
    ['revoking all other sessions', () => revokeAllSessions(memberId, 'fam-b')],
    ['a password change', () => changePasswordAtomically(memberId, 'newhash', 'fam-b')],
  ] as const)('%s refuses the revoked connection', async (_name, act) => {
    const revoked = await connectSynced(await loginCookie(memberId, 'fam-a'))
    const kept = await connectSynced(await loginCookie(memberId, 'fam-b'))
    await act()
    await waitFor(() => revoked.failures.includes('unauthorized'))
    await new Promise((r) => setTimeout(r, 200))
    expect(kept.failures).toEqual([])
  })

  it('an IP ban makes connections from it re-authenticate, and they are refused', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const closes = closesOf(editor)
    try {
      await blockIp('127.0.0.1', 'r', adminId)
      await waitFor(() => closes.length > 0)
      expect(closes[0]).toEqual({ code: 4409, reason: 'reauth' })
      await waitFor(() => editor.failures.includes('forbidden'))
    } finally {
      await BannedIp.deleteMany({})
    }
  })
})

describe('collab awareness and stateless limits', () => {
  it('an oversized awareness state is never relayed, and a normal one after it is', async () => {
    const speaker = await connectSynced(guest('sp', editorInvite))
    const peer = await connectSynced(await ownerCookie())
    const id = speaker.doc.clientID
    speaker.provider.setAwarenessField('small', 'ok')
    await waitFor(() => peer.provider.awareness!.getStates().get(id)?.small === 'ok')
    speaker.provider.setAwarenessField('blob', 'x'.repeat(5000))
    await new Promise((r) => setTimeout(r, 200))
    expect(peer.provider.awareness!.getStates().get(id)?.blob).toBeUndefined()
    speaker.provider.setAwarenessField('blob', null)
    speaker.provider.setAwarenessField('small', 'again')
    await waitFor(() => peer.provider.awareness!.getStates().get(id)?.small === 'again')
  })

  it('a flood of awareness messages is cut to the bucket', async () => {
    const speaker = await connectSynced(guest('sp', editorInvite))
    const peer = await connectSynced(await ownerCookie())
    await new Promise((r) => setTimeout(r, 100))
    let relayed = 0
    peer.provider.awareness!.on('update', () => { relayed++ })
    const started = Date.now()
    for (let i = 0; i < 400; i++) {
      speaker.provider.setAwarenessField('n', i)
      await new Promise((r) => setImmediate(r))
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(relayed).toBeGreaterThan(0)
    // The burst plus the refill over the time taken, with room for scheduling.
    expect(relayed).toBeLessThan(60 + ((Date.now() - started) / 1000) * 30 + 20)
  })

  it('a flood of stateless messages is cut to the bucket', async () => {
    const client = await connectSynced(guest('sp', editorInvite))
    await new Promise((r) => setTimeout(r, 50))
    for (let i = 0; i < 400; i++) client.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'missing' }))
    await new Promise((r) => setTimeout(r, 500))
    const denied = client.stateless.filter((m) => m.t === 'lock-denied').length
    expect(denied).toBeGreaterThan(0)
    expect(denied).toBeLessThan(150)
  })

  it('one connection holds at most 20 locks, by lock or by heartbeat', async () => {
    const client = await connectSynced(guest('sp', editorInvite))
    const lines = client.doc.getMap<Y.Map<unknown>>('lines')
    const ids = Array.from({ length: 25 }, (_, i) => `x${i}`)
    client.doc.transact(() => {
      for (const id of ids) {
        const m = new Y.Map<unknown>()
        m.set('id', id)
        m.set('order', `a${id}`)
        m.set('text', id)
        lines.set(id, m)
      }
    })
    await waitFor(() => !client.provider.hasUnsyncedChanges)
    for (const lineId of ids) client.provider.sendStateless(JSON.stringify({ t: 'lock', lineId }))
    await waitFor(() => client.stateless.filter((m) => m.t === 'lock-denied').length === 5)
    await waitFor(() => Object.keys(lastLocks(client) ?? {}).length === 20)

    client.provider.sendStateless(JSON.stringify({ t: 'heartbeat', lineIds: ids }))
    await waitFor(() => client.stateless.filter((m) => m.t === 'lock-denied').length === 10)
    expect(Object.keys(lastLocks(client)!)).toHaveLength(20)

    // Re-locking one already held is not a new lock; releasing one makes room.
    client.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'x0' }))
    client.provider.sendStateless(JSON.stringify({ t: 'unlock', lineId: 'x1' }))
    client.provider.sendStateless(JSON.stringify({ t: 'lock', lineId: 'x24' }))
    await waitFor(() => !!lastLocks(client)?.x24)
    expect(client.stateless.filter((m) => m.t === 'lock-denied')).toHaveLength(10)
  })
})

describe('collab expiry', () => {
  const DAY = 86_400_000
  const live = () => CollabSession.exists({ _id: sessionId, endedAt: null })
  const lastActivity = async () => (await CollabSession.findById(sessionId).lean())!.lastActivityAt!.getTime()
  const age = (ms: number) => CollabSession.updateOne({ _id: sessionId }, { $set: { lastActivityAt: new Date(Date.now() - ms) } })

  it('an invite older than 7 days is refused with the revoked-link code and shows as revoked', async () => {
    const token = await createInvite(PUBLIC_ID, 'editor', ownerId)
    const join = () => joinSession({ token, name: 'Ana', userId: null })
    await expect(join()).resolves.toMatchObject({ publicId: PUBLIC_ID })
    await CollabSession.updateOne(
      { _id: sessionId, 'invites.tokenHash': hashInviteToken(token) },
      { $set: { 'invites.$.createdAt': new Date(Date.now() - 7 * DAY - 1000) } },
    )
    await expect(join()).rejects.toMatchObject({ code: 'collab_link_revoked' })
    const view = await getSessionView(PUBLIC_ID, ownerId)
    expect(view!.invites.find((i) => i.role === 'editor' && i.revoked)).toBeTruthy()
  })

  it('a session idle for 24 hours with nobody connected ends, keeping its edits', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'kept')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    close(editor)
    await waitFor(async () => (await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text === 'kept')
    await new Promise((r) => setTimeout(r, 150))
    await age(DAY + 1000)
    expect(await endIdleSessions()).toBe(1)
    expect(await live()).toBeNull()
    expect(await CollabDoc.exists({ name: DOC })).toBeNull()
    expect((await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text).toBe('kept')
  })

  it('the sweep leaves a session with a live connection, and one active within the day', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    await age(DAY + 1000)
    expect(getCollabServer().hasConnections(DOC)).toBe(true)
    expect(await endIdleSessions()).toBe(0)
    expect(await live()).not.toBeNull()
    close(editor)
    await new Promise((r) => setTimeout(r, 150))
    await age(DAY - 60_000)
    expect(getCollabServer().hasConnections(DOC)).toBe(false)
    expect(await endIdleSessions()).toBe(0)
    expect(await live()).not.toBeNull()
  })

  it('activity moves lastActivityAt, at most once per throttle window per doc', async () => {
    await age(DAY)
    const before = await lastActivity()
    const editor = await connectSynced(guest('ed', editorInvite))
    await waitFor(async () => await lastActivity() > before)
    // Inside the window: an edit is not written.
    await age(1000 * 60 * 60)
    const aged = await lastActivity()
    const lines = editor.doc.getMap<Y.Map<unknown>>('lines')
    lines.get('l1')!.set('text', 'a')
    await waitFor(() => !editor.provider.hasUnsyncedChanges)
    await new Promise((r) => setTimeout(r, 100))
    expect(await lastActivity()).toBe(aged)
    // Past the window: the next edit is.
    const realNow = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000)
    try {
      lines.get('l1')!.set('text', 'b')
      await waitFor(async () => await lastActivity() > aged)
    } finally {
      clock.mockRestore()
    }
  })
})

describe('collab minors', () => {
  it('guest names are cleaned at join with the same cleaner credits use', async () => {
    const token = await createInvite(PUBLIC_ID, 'editor', ownerId)
    await joinSession({ token, name: '<b>Ana</b>\u202E\u0007', userId: null })
    const s = await CollabSession.findById(sessionId).lean()
    expect(s!.members.at(-1)!.name).toBe('Ana')
    for (const name of ['<b></b>', '\u202E\u0007', '   ']) {
      await expect(joinSession({ token, name, userId: null })).rejects.toMatchObject({ code: 'collab_invalid_name' })
    }
  })

  it('admission limits come from the environment, with the old values as defaults', () => {
    const saved = { u: process.env.COLLAB_UPGRADES_PER_MINUTE, c: process.env.COLLAB_MAX_CONNECTIONS_PER_IP }
    try {
      delete process.env.COLLAB_UPGRADES_PER_MINUTE
      delete process.env.COLLAB_MAX_CONNECTIONS_PER_IP
      expect(loadEnv()).toMatchObject({ COLLAB_UPGRADES_PER_MINUTE: 30, COLLAB_MAX_CONNECTIONS_PER_IP: 20 })
      process.env.COLLAB_UPGRADES_PER_MINUTE = '90'
      process.env.COLLAB_MAX_CONNECTIONS_PER_IP = 'lots'
      expect(loadEnv()).toMatchObject({ COLLAB_UPGRADES_PER_MINUTE: 90, COLLAB_MAX_CONNECTIONS_PER_IP: 20 })
    } finally {
      if (saved.u === undefined) delete process.env.COLLAB_UPGRADES_PER_MINUTE
      else process.env.COLLAB_UPGRADES_PER_MINUTE = saved.u
      if (saved.c === undefined) delete process.env.COLLAB_MAX_CONNECTIONS_PER_IP
      else process.env.COLLAB_MAX_CONNECTIONS_PER_IP = saved.c
    }
  })

  it('a full session refuses a new member at connect time, but never its owner', async () => {
    const members = Array.from({ length: 50 }, (_, i) => ({ subject: `guest:m${i}`, role: 'viewer', colorIndex: 1, name: `m${i}` }))
    await CollabSession.updateOne({ _id: sessionId }, { $set: { members } })
    await expect(resolvePrincipal({ cookieHeader: guest('late', editorInvite), docName: DOC })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await CollabSession.findById(sessionId).lean())!.members).toHaveLength(50)
    await expect(resolvePrincipal({ cookieHeader: guest('m1', editorInvite), docName: DOC })).resolves.toMatchObject({ subject: 'guest:m1' })
    await expect(resolvePrincipal({ cookieHeader: await ownerCookie(), docName: DOC })).resolves.toMatchObject({ role: 'owner' })
  })

  it('the kicked list is capped, and kicking someone already on it still works', async () => {
    const kicked = Array.from({ length: 200 }, (_, i) => `guest:k${i}`)
    await CollabSession.updateOne({ _id: sessionId }, { $set: { kicked } })
    await expect(kick(PUBLIC_ID, 'guest:one-more', ownerId)).rejects.toMatchObject({ code: 'collab_kick_limit' })
    await expect(kick(PUBLIC_ID, 'guest:k3', ownerId)).resolves.toBeTruthy()
    expect((await CollabSession.findById(sessionId).lean())!.kicked).toHaveLength(200)
  })

  it('endSession: read-only first, then the final store, then the notice, then the close', async () => {
    const editor = await connectSynced(guest('ed', editorInvite))
    const owner = await connectSynced(await ownerCookie())
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'in time')
    await waitFor(() => lineText(owner.doc, 'l1') === 'in time')

    const real = Lyrics.findOneAndUpdate.bind(Lyrics) as (...args: unknown[]) => { select: (s: string) => { lean: () => Promise<unknown> } }
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const spy = vi.spyOn(Lyrics, 'findOneAndUpdate').mockImplementationOnce(((...args: unknown[]) => ({
      select: (s: string) => ({ lean: () => gate.then(() => real(...args).select(s).lean()) }),
    })) as never)
    const ending = endSession(PUBLIC_ID, ownerId)
    await waitFor(() => spy.mock.calls.length > 0)
    // The final store is running: nobody has been told yet, and a late edit lands nowhere.
    expect(editor.stateless.some((m) => m.t === 'session-ended')).toBe(false)
    editor.doc.getMap<Y.Map<unknown>>('lines').get('l1')!.set('text', 'too late')
    await new Promise((r) => setTimeout(r, 150))
    expect(lineText(owner.doc, 'l1')).toBe('in time')
    release()
    await ending
    spy.mockRestore()
    expect(owner.stateless.some((m) => m.t === 'session-ended')).toBe(true)
    expect((await Lyrics.findOne({ publicId: PUBLIC_ID }).lean())!.sections[0].lines[0].text).toBe('in time')
  })

  it('meta.media follows the Project on a load, stored doc or fresh seed', async () => {
    const first = await Upload.create({ userId: ownerId, source: 'youtube', uploadUrl: 'https://youtu.be/aaaaaaaaaaa', fileName: 'a', title: 'a' })
    const second = await Upload.create({ userId: ownerId, source: 'youtube', uploadUrl: 'https://youtu.be/bbbbbbbbbbb', fileName: 'b', title: 'b' })
    const mediaOf = (c: Client) => c.doc.getMap('meta').get('media') as { uploadId: string | null }
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { uploadId: first._id } })
    const a = await connectSynced(await ownerCookie())
    expect(mediaOf(a).uploadId).toBe(first.id)
    close(a)
    await new Promise((r) => setTimeout(r, 150))
    // A stored doc left behind (a restart mid-session, say) with the Project moved on.
    await Project.updateOne({ publicId: PUBLIC_ID }, { $set: { uploadId: second._id } })
    const b = await connectSynced(await ownerCookie())
    expect(mediaOf(b).uploadId).toBe(second.id)
    expect(b.doc.getMap('lines').size).toBe(2)
    await endSession(PUBLIC_ID, ownerId)
    close(b)
    await Project.updateOne({ publicId: PUBLIC_ID }, { $unset: { uploadId: 1 } })
    await startSession(PUBLIC_ID, ownerId)
    const c = await connectSynced(await ownerCookie())
    expect(mediaOf(c).uploadId).toBeNull()
  })
})
