/**
 * Hocuspocus wiring for collaborative sessions: auth, persistence and the
 * per-line lock protocol (stateless messages, see shared-schema.md).
 *
 * SINGLE-INSTANCE ONLY. Loaded Y.Docs, their connections and the lock table
 * all live in this process; with more than one server instance two clients of
 * the same project can land on different instances and never see each other.
 * Same constraint as socket/project-viewers.ts, asr/job.store.ts and the
 * requests pending queue — see .claude/rules/technical-debt.md.
 */
import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import { Hocuspocus } from '@hocuspocus/server'
import type { Connection, Document, WebSocketLike, onStatelessPayload } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import type { WebSocket, RawData } from 'ws'
import * as Y from 'yjs'
import type { FastifyBaseLogger } from 'fastify'
import Project from '../projects/project.model.js'
import Lyrics, { migrateLinesToSections } from '../lyrics/lyrics.model.js'
import Upload from '../uploads/upload.model.js'
import type { LineEntry } from '../../types/index.js'
import CollabDoc from './collab-doc.model.js'
import { createLockTable } from './collab.locks.js'
import { docToSections, sanitizeSectionsForLyrics, seedDocFromProject, validEditorMode } from './collab.projection.js'
import { CollabAuthError, resolvePrincipal, type CollabPrincipal } from './collab.auth.js'
import type { CollabMeta } from './collab.types.js'

const LOCK_IDLE_MS = 30_000
const SWEEP_MS = 5_000
const STORE_DEBOUNCE_MS = 2_000
const STORE_MAX_DEBOUNCE_MS = 10_000
// Same as Lyrics.lineSchema `id` maxlength: a lockable line id is always a persistable one.
const MAX_LINE_ID = 50
const MAX_HEARTBEAT_IDS = 200
/** Encoded doc state cap. Stays well under Mongo's 16 MB BSON limit even after one 5 MiB frame lands on top. */
export const DEFAULT_MAX_DOC_BYTES = 4 * 1024 * 1024
/** Bytes of incoming updates between exact size re-measurements of a doc. */
const RECHECK_BYTES = 64 * 1024
/** Documents one socket may have pending authentication; Hocuspocus defaults to 100. */
const MAX_PENDING_DOCUMENTS = 4
/** Upper bound on how long shutdown waits for pending stores before giving up. */
const DESTROY_TIMEOUT_MS = 10_000

// Application close codes (4000–4999 are free for app use).
const CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  session_ended: 4410,
  kicked: 4403,
  roleChanged: 4409,
  tooLarge: 4413,
} as const

type CollabContext = { ws: WebSocket; ip?: string; principal?: CollabPrincipal; connId?: string }

export type CollabServer = {
  closeSubject(docName: string, subject: string): void
  endSession(docName: string): Promise<void>
  reconnectSubject(docName: string, subject: string): void
  broadcastLocks(docName: string): void
}

export type MountedCollabServer = CollabServer & {
  handleSocket(ws: WebSocket, req: IncomingMessage, ip: string | undefined): void
  destroy(): Promise<void>
}

let current: MountedCollabServer | null = null

export function getCollabServer(): CollabServer {
  if (!current) throw new Error('collab server is not mounted')
  return current
}

function publicIdOf(docName: string): string {
  return docName.slice('project:'.length)
}

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function toFetchRequest(req: IncomingMessage): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  return new Request(`http://localhost${req.url ?? '/'}`, { headers })
}

/** Initial Y.Doc state for a project: the stored CollabDoc if it is current, else a seed from Lyrics. */
async function fetchState(docName: string): Promise<Uint8Array> {
  const publicId = publicIdOf(docName)
  const [stored, lyrics] = await Promise.all([
    CollabDoc.findOne({ name: docName }),
    Lyrics.findOne({ publicId }).select('+lines sections editorMode version').lean<{
      sections?: unknown[]; lines?: LineEntry[]; editorMode?: CollabMeta['editorMode']; version?: number
    }>(),
  ])
  const lyricsVersion = lyrics?.version ?? 0
  // `>=`, not `===`: storeState records the version Lyrics is *about* to reach in
  // the same write as the state, so a crash before the Lyrics write leaves the
  // CollabDoc one ahead, and it is the newer copy. Only a Lyrics version past the
  // CollabDoc's means someone wrote Lyrics outside the session, which re-seeds.
  if (stored && typeof stored.lyricsVersion === 'number' && stored.lyricsVersion >= lyricsVersion) {
    return new Uint8Array(stored.state)
  }

  const project = await Project.findOne({ publicId }).select('title metadata uploadId').lean()
  if (!project) throw new Error('collab: project not found')
  const upload = project.uploadId
    ? await Upload.findById(project.uploadId).select('source uploadUrl').lean()
    : null
  const md = (project.metadata ?? {}) as { songName?: string; songArtist?: string; songAlbum?: string }
  const meta: CollabMeta = {
    editorMode: lyrics?.editorMode ?? 'lrc',
    title: md.songName || project.title || null,
    artist: md.songArtist || null,
    album: md.songAlbum || null,
    media: upload
      ? { source: upload.source, url: upload.uploadUrl ?? null, uploadId: String(upload._id) }
      : { source: null, url: null, uploadId: null },
  }
  const sections = lyrics?.sections?.length ? lyrics.sections : migrateLinesToSections(lyrics?.lines ?? [])

  const seed = new Y.Doc()
  seedDocFromProject(seed, sections, meta)
  const update = Y.encodeStateAsUpdate(seed)
  seed.destroy()
  // Persist the seed right away: a re-seed on the next load would mint new Yjs
  // items, and a client still holding the old ones would merge both.
  await CollabDoc.updateOne(
    { name: docName },
    { $set: { state: Buffer.from(update), lyricsVersion } },
    { upsert: true },
  )
  return update
}

async function storeState(docName: string, document: Document, state: Buffer, log: FastifyBaseLogger): Promise<void> {
  const publicId = publicIdOf(docName)
  let expectedVersion: number | null
  try {
    const current = await Lyrics.findOne({ publicId }).select('version').lean<{ version: number }>()
    expectedVersion = current ? current.version + 1 : null
    // State and the Lyrics version it is about to project into, in ONE write: no
    // crash window leaves a CollabDoc that a load would re-seed over (a re-seed
    // mints new Yjs items and duplicates every line for clients holding the old ones).
    await CollabDoc.updateOne(
      { name: docName },
      { $set: { state, ...(expectedVersion !== null ? { lyricsVersion: expectedVersion } : {}) } },
      { upsert: true },
    )
  } catch (err) {
    log.error({ err, docName }, 'collab: persisting doc state failed; keeping the doc in memory')
    // Rethrown on purpose: Hocuspocus catches a failed store (storeDocumentHooks)
    // and keeps the doc loaded instead of unloading, and losing, unpersisted edits.
    throw err
  }
  if (expectedVersion === null) return // no Lyrics document (project deleted): nothing to project into

  try {
    const $set: Record<string, unknown> = { sections: sanitizeSectionsForLyrics(docToSections(document)) }
    const mode = validEditorMode(document.getMap('meta').get('editorMode'))
    if (mode) $set.editorMode = mode
    // Mirrors the lyrics write in projects.crud.service updateProject. No upsert:
    // a store landing after the project was deleted must not resurrect its lyrics.
    const lyrics = await Lyrics.findOneAndUpdate(
      { publicId },
      { $set, $unset: { lines: 1 }, $inc: { version: 1 } },
      { returnDocument: 'after', runValidators: true },
    ).select('version').lean<{ version: number }>()
    if (!lyrics) return
    // A solo save raced in between the read and this write: record the real version.
    if (lyrics.version !== expectedVersion) {
      await CollabDoc.updateOne({ name: docName }, { $set: { lyricsVersion: lyrics.version } })
    }
    await Project.updateOne({ publicId }, { $set: { contentUpdatedAt: new Date() }, $inc: { version: 1 } })
  } catch (err) {
    // The CollabDoc already holds the truth; a projection failure must not keep the doc from persisting.
    log.error({ err, docName }, 'collab: projecting doc into Lyrics failed')
  }
}

type LockMsg =
  | { t: 'lock' | 'unlock' | 'force-unlock'; lineId: string }
  | { t: 'heartbeat'; lineIds: string[] }

function parseMessage(payload: string): LockMsg | null {
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_LINE_ID
  if ((m.t === 'lock' || m.t === 'unlock' || m.t === 'force-unlock') && validId(m.lineId)) {
    return { t: m.t, lineId: m.lineId }
  }
  if (m.t === 'heartbeat' && Array.isArray(m.lineIds)) {
    return { t: 'heartbeat', lineIds: m.lineIds.filter(validId).slice(0, MAX_HEARTBEAT_IDS) }
  }
  return null
}

export type CollabServerOptions = { maxDocBytes?: number }

export function createCollabServer(log: FastifyBaseLogger, opts: CollabServerOptions = {}): MountedCollabServer {
  const maxDocBytes = opts.maxDocBytes ?? DEFAULT_MAX_DOC_BYTES
  /** Last exact encoded size per loaded doc, plus update bytes received since. */
  const docSize = new Map<string, { bytes: number; pending: number }>()
  /**
   * Docs over the cap: every connection is read-only. Kept across unloads (the
   * stored state is just as big), so a reconnect is told it is read-only at auth
   * time; only a fresh load that measures under the cap clears an entry.
   */
  const frozen = new Set<string>()
  const locks = createLockTable({ idleMs: LOCK_IDLE_MS })
  const sockets = new Set<WebSocket>()
  let onAllUnloaded: (() => void) | null = null

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'collab',
    quiet: true,
    debounce: STORE_DEBOUNCE_MS,
    maxDebounce: STORE_MAX_DEBOUNCE_MS,
    maxPendingDocuments: MAX_PENDING_DOCUMENTS,
    extensions: [
      new Database({
        fetch: ({ documentName }) => fetchState(documentName),
        store: ({ documentName, document, state }) => storeState(documentName, document, state, log),
      }),
    ],

    async onAuthenticate({ documentName, requestHeaders, requestParameters, connectionConfig, context }) {
      try {
        const principal = await resolvePrincipal({
          cookieHeader: requestHeaders.get('cookie') ?? '',
          docName: documentName,
          ip: context.ip,
          // Browsers cannot set headers on a WebSocket, so the client passes it as a query param.
          deviceId: requestParameters.get('deviceId') ?? requestHeaders.get('x-device-id') ?? undefined,
        })
        if (principal.role === 'viewer' || frozen.has(documentName)) connectionConfig.readOnly = true
        return { principal, connId: randomUUID() }
      } catch (err) {
        const code = err instanceof CollabAuthError ? err.code : 'forbidden'
        if (!(err instanceof CollabAuthError)) log.error({ err, documentName }, 'collab: auth failed unexpectedly')
        // Hocuspocus answers with permission-denied but leaves the socket open; close it
        // once that message is out so a refused client never holds a socket idle.
        setTimeout(() => context.ws.close(CLOSE[code], code), 0)
        // A plain object (no `message`) keeps Hocuspocus from logging every refusal.
        throw { reason: code }
      }
    },

    async onStateless({ connection, documentName, document, payload }: onStatelessPayload) {
      const ctx = connection.context as CollabContext
      if (!ctx.principal || !ctx.connId) return
      const msg = parseMessage(payload)
      if (!msg) return
      const lines = document.getMap('lines')
      const holder = { conn: ctx.connId, subject: ctx.principal.subject, name: ctx.principal.name, colorIndex: ctx.principal.colorIndex }
      const deny = (lineId: string) => connection.sendStateless(JSON.stringify({ t: 'lock-denied', lineId }))
      let changed = false

      if (msg.t === 'lock') {
        if (connection.readOnly || !lines.has(msg.lineId)) return deny(msg.lineId)
        const res = locks.acquire(documentName, msg.lineId, holder)
        if (!res.ok) return deny(msg.lineId)
        changed = true
      } else if (msg.t === 'unlock') {
        changed = locks.release(documentName, msg.lineId, ctx.connId)
      } else if (msg.t === 'force-unlock') {
        if (ctx.principal.role !== 'owner') return
        changed = locks.forceRelease(documentName, msg.lineId)
      } else if (msg.t === 'heartbeat') {
        // A heartbeat for a line this conn no longer holds (its lock expired) is a
        // re-acquire attempt; refresh() alone never revives an expired lock.
        const held = locks.snapshot(documentName)
        const mine = msg.lineIds.filter((id) => held[id]?.conn === ctx.connId)
        locks.refresh(documentName, mine, ctx.connId)
        for (const lineId of msg.lineIds) {
          if (held[lineId]?.conn === ctx.connId) continue
          if (connection.readOnly || !lines.has(lineId) || !locks.acquire(documentName, lineId, holder).ok) deny(lineId)
          else changed = true
        }
      }
      if (changed) broadcastLocks(documentName)
    },

    async onDisconnect({ documentName, context }) {
      if (!context.connId) return
      if (locks.releaseAllFor(documentName, context.connId).length > 0) broadcastLocks(documentName)
    },

    async afterLoadDocument({ documentName, document }) {
      const bytes = Y.encodeStateAsUpdate(document).byteLength
      docSize.set(documentName, { bytes, pending: 0 })
      if (bytes > maxDocBytes) frozen.add(documentName)
      else frozen.delete(documentName)
    },

    // Covers the first load after a restart, where auth ran before the size was known.
    async connected({ documentName, connection }) {
      if (frozen.has(documentName)) connection.readOnly = true
    },

    // The 5 MiB ws frame cap bounds one message, not the doc: without this, editors
    // could grow a doc past Mongo's 16 MB BSON limit, after which every store fails.
    // An exact re-measure costs a full encode, so it runs every RECHECK_BYTES of
    // incoming updates, or on every change once the doc is near the cap.
    async onChange({ documentName, document, update, connection }) {
      const size = docSize.get(documentName) ?? { bytes: 0, pending: 0 }
      size.pending += update.byteLength
      if (size.pending >= RECHECK_BYTES || size.bytes + size.pending > maxDocBytes) {
        size.bytes = Y.encodeStateAsUpdate(document).byteLength
        size.pending = 0
      }
      docSize.set(documentName, size)
      if (size.bytes <= maxDocBytes) return
      if (!frozen.has(documentName)) log.warn({ documentName, bytes: size.bytes }, 'collab: doc over size cap; now read-only')
      frozen.add(documentName)
      if (connection) {
        connection.readOnly = true // drop anything it already queued
        drop(connection, CLOSE.tooLarge, 'doc-too-large')
      }
    },

    async afterUnloadDocument({ documentName }) {
      locks.clearDoc(documentName)
      docSize.delete(documentName)
      if (onAllUnloaded && hocuspocus.getDocumentsCount() === 0) onAllUnloaded()
    },
  })

  function broadcastLocks(docName: string): void {
    const doc = hocuspocus.documents.get(docName)
    if (!doc) return
    const locksOut: Record<string, { holderConn: string; subject: string; name: string; colorIndex: number }> = {}
    for (const [lineId, h] of Object.entries(locks.snapshot(docName))) {
      locksOut[lineId] = { holderConn: h.conn, subject: h.subject, name: h.name, colorIndex: h.colorIndex }
    }
    doc.broadcastStateless(JSON.stringify({ t: 'locks', locks: locksOut }))
  }

  function connectionsOf(docName: string, match: (c: CollabContext) => boolean): Connection[] {
    const doc = hocuspocus.documents.get(docName)
    return doc ? doc.getConnections().filter((c) => match(c.context as CollabContext)) : []
  }

  /** Close one document connection and its socket; the provider reconnects and re-authenticates. */
  function drop(conn: Connection, code: number, reason: string): void {
    conn.close({ code, reason })
    ;(conn.context as CollabContext).ws.close(code, reason)
  }

  const sweepTimer = setInterval(() => {
    for (const docName of locks.sweep()) broadcastLocks(docName)
  }, SWEEP_MS)
  sweepTimer.unref()

  const server: MountedCollabServer = {
    handleSocket(ws, req, ip) {
      sockets.add(ws)
      const client = hocuspocus.handleConnection(ws as unknown as WebSocketLike, toFetchRequest(req), { ws, ip })
      ws.on('message', (data: RawData) => client.handleMessage(toUint8(data)))
      ws.on('pong', () => client.touch())
      ws.on('error', (err) => log.debug({ err }, 'collab: websocket error'))
      ws.on('close', (code: number, reason: Buffer) => {
        sockets.delete(ws)
        client.handleClose({ code, reason: reason.toString() })
      })
    },

    broadcastLocks,

    closeSubject(docName, subject) {
      locks.releaseSubject(docName, subject)
      for (const c of connectionsOf(docName, (ctx) => ctx.principal?.subject === subject)) drop(c, CLOSE.kicked, 'kicked')
      broadcastLocks(docName)
    },

    reconnectSubject(docName, subject) {
      for (const c of connectionsOf(docName, (ctx) => ctx.principal?.subject === subject)) drop(c, CLOSE.roleChanged, 'role-changed')
    },

    async endSession(docName) {
      const doc = hocuspocus.documents.get(docName)
      if (doc) {
        doc.broadcastStateless(JSON.stringify({ t: 'session-ended' }))
        await hocuspocus.storeDocumentHooks(doc, {
          instance: hocuspocus,
          clientsCount: doc.getConnectionsCount(),
          document: doc,
          documentName: docName,
          lastContext: {} as CollabContext,
          lastTransactionOrigin: null,
        }, true)
        for (const c of doc.getConnections()) drop(c, CLOSE.session_ended, 'session-ended')
      }
      locks.clearDoc(docName)
      frozen.delete(docName) // a later session re-seeds from Lyrics
    },

    async destroy() {
      clearInterval(sweepTimer)
      // Same sequence as @hocuspocus/server's Server.destroy(): close every
      // connection, run pending debounced stores now, wait for the unloads.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DESTROY_TIMEOUT_MS)
        timer.unref()
        onAllUnloaded = () => {
          clearTimeout(timer)
          resolve()
        }
        if (hocuspocus.getDocumentsCount() === 0) onAllUnloaded()
        hocuspocus.closeConnections()
        hocuspocus.flushPendingStores()
      })
      for (const ws of sockets) ws.terminate()
      sockets.clear()
      if (current === server) current = previous
    },
  }

  // Stack-like so a second server (tests mount more than one app) hands the slot back on destroy.
  const previous = current
  current = server
  return server
}
