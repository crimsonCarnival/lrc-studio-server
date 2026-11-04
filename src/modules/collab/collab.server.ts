/**
 * Hocuspocus wiring for collaborative sessions: auth, persistence and the
 * per-line lock protocol (stateless messages, see shared-schema.md).
 *
 * SINGLE-INSTANCE ONLY. Loaded Y.Docs, their connections and the lock table
 * all live in this process; with more than one server instance two clients of
 * the same project can land on different instances and never see each other.
 * Same constraint as socket/project-viewers.ts, asr/job.store.ts and the
 * requests pending queue — see .claude/rules/technical-debt.md.
 *
 * In-memory state (single instance is confirmed; no multi-instance machinery):
 * Hocuspocus' loaded documents, the lock table, docSize, frozen, awarenessIds,
 * the awareness/stateless rate buckets, dirty (failed stores awaiting retry),
 * discarded, discardAfterStore, settling, the activity throttle, and handled credits.
 */
import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import { Hocuspocus } from '@hocuspocus/server'
import type { Connection, Document, WebSocketLike, onStatelessPayload } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import type { WebSocket, RawData } from 'ws'
import * as Y from 'yjs'
import { removeAwarenessStates, type Awareness } from 'y-protocols/awareness'
import type { FastifyBaseLogger } from 'fastify'
import Project from '../projects/project.model.js'
import Lyrics, { migrateLinesToSections } from '../lyrics/lyrics.model.js'
import Upload from '../uploads/upload.model.js'
import type { LineEntry } from '../../types/index.js'
import CollabDoc from './collab-doc.model.js'
import CollabSession from './collab-session.model.js'
import { createLockTable } from './collab.locks.js'
import { docToMeta, docToSections, sanitizeSectionsForLyrics, seedDocFromProject, validEditorMode } from './collab.projection.js'
import { cleanTitle, hasProjectIdentity, PROJECT_SONG_NAME_MAX, slugFor } from '../projects/project-identity.js'
import { stripHtml } from '../../utils/sanitize.js'
import { CollabAuthError, resolvePrincipal, type CollabPrincipal } from './collab.auth.js'
import type { CollabMeta } from './collab.types.js'
import { clearHandled, creditCollaborator, handledSubjects } from './collab-credits.service.js'

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
const UNLOAD_POLL_MS = 10
/** How often a doc whose last store failed is stored again. */
const DEFAULT_STORE_RETRY_MS = 10_000
/** A client awareness state larger than this (JSON length) is never relayed. */
const MAX_AWARENESS_STATE_CHARS = 4 * 1024
/** Per-connection token buckets: awareness messages and lock-protocol messages. */
const AWARENESS_RATE = { perSec: 30, burst: 60 }
const STATELESS_RATE = { perSec: 30, burst: 60 }
/** Lines one connection may hold locked at once. */
const MAX_LOCKS_PER_CONN = 20
/** Minimum gap between lastActivityAt writes for one doc. The idle threshold is a day. */
const ACTIVITY_THROTTLE_MS = 60_000

// Application close codes (4000–4999 are free for app use).
const CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  session_ended: 4410,
  kicked: 4403,
  roleChanged: 4409,
  reauth: 4409,
  tooLarge: 4413,
} as const

type TokenBucket = { tokens: number; at: number }
type CollabContext = {
  ws: WebSocket
  ip?: string
  principal?: CollabPrincipal
  connId?: string
  awarenessTokens?: TokenBucket
  statelessTokens?: TokenBucket
}

function takeToken(bucket: TokenBucket, rate: { perSec: number; burst: number }): boolean {
  const now = Date.now()
  bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.at) / 1000) * rate.perSec)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

export type CollabServer = {
  closeSubject(docName: string, subject: string): void
  /** Final projection, then closes every connection and deletes the stored doc: the next session seeds from Lyrics. */
  endSession(docName: string): Promise<void>
  /** An ended session's final store has not landed yet, so a solo save would be written over. */
  isFlushingEnd(docName: string): boolean
  /** For a deleted project: closes every connection without storing anything and deletes the stored doc. */
  discardSession(docName: string): Promise<void>
  reconnectSubject(docName: string, subject: string): void
  /** Closes every live connection of a signed-in user, in every doc (ban, account deletion). */
  closeUserEverywhere(userId: string): void
  /** Makes every connection of a signed-in user re-authenticate (a revoked login session is refused there). */
  reauthUserEverywhere(userId: string): void
  /** Makes every connection from this IP re-authenticate, where network bans apply. */
  reauthIpEverywhere(ip: string): void
  /** Connections on this process, which is all of them: production runs one instance. */
  hasConnections(docName: string): boolean
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

/** The mounted server, or null where none is (jobs and tests that run without the plugin). */
export function mountedCollabServer(): CollabServer | null {
  return current
}

/**
 * Tells the mounted server about a ban or a revocation that has already happened. Never throws:
 * failing to close a socket must not fail the moderation action, and the next re-auth still refuses.
 */
export function withCollabServer(action: (server: CollabServer) => void): void {
  try {
    if (current) action(current)
  } catch (err) {
    console.error('[collab] reaching live connections failed', err)
  }
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

function readLyrics(publicId: string) {
  return Lyrics.findOne({ publicId }).select('+lines sections editorMode version').lean<{
    sections?: unknown[]; lines?: LineEntry[]; editorMode?: CollabMeta['editorMode']; version?: number
  }>()
}

/**
 * Initial Y.Doc state for a project: the stored CollabDoc if it is current, else a seed from Lyrics.
 * Null when the project or its live session is gone, whatever is still stored. Checked after the read,
 * so a delete or an end landing during it is seen, and before the seed's upsert can recreate the doc.
 */
async function fetchState(docName: string): Promise<Uint8Array | null> {
  const publicId = publicIdOf(docName)
  const [stored, lyrics] = await Promise.all([CollabDoc.findOne({ name: docName }), readLyrics(publicId)])
  const [hasProject, hasSession] = await Promise.all([
    Project.exists({ publicId }),
    CollabSession.exists({ publicId, endedAt: null }),
  ])
  if (!hasProject || !hasSession) return null
  const lyricsVersion = lyrics?.version ?? 0
  const lyricsSections = lyrics?.sections?.length ? lyrics.sections : migrateLinesToSections(lyrics?.lines ?? [])

  if (stored) {
    // lyricsVersion is only ever the version Lyrics actually reached from this doc
    // (storeState sets it after a successful projection), so equal means current.
    if (typeof stored.lyricsVersion === 'number' && stored.lyricsVersion >= lyricsVersion) {
      return syncMetaFromProject(docName, new Uint8Array(stored.state))
    }
    // Lyrics moved past the doc. Either someone saved outside the session (re-seed),
    // or the process died between the Lyrics write and the lyricsVersion write: then
    // Lyrics holds exactly the doc's projection, and re-seeding would mint new Yjs
    // items and duplicate every line for clients still holding the old ones.
    const state = new Uint8Array(stored.state)
    if (lyrics && docMatchesLyrics(state, lyricsSections, lyrics.editorMode ?? 'lrc')) {
      await CollabDoc.updateOne({ name: docName }, { $set: { lyricsVersion } })
      return syncMetaFromProject(docName, state)
    }
  }

  const project = await Project.findOne({ publicId }).select('title metadata uploadId coverImage').lean()
  if (!project) return null
  const meta: CollabMeta = {
    editorMode: lyrics?.editorMode ?? 'lrc',
    // The model's ProjectMetadata type doesn't declare the song fields the schema stores.
    ...songMeta(project as unknown as SongSource),
    media: await mediaFor(project.uploadId),
  }
  const seed = new Y.Doc()
  seedDocFromProject(seed, lyricsSections, meta)
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

/**
 * Sections in the exact shape Lyrics persists them: cast through the model so
 * defaults, setters (HTML stripping) and field order all match a stored document.
 */
function canonicalSections(sections: unknown[]): string {
  const sanitized = sanitizeSectionsForLyrics(sections)
  return JSON.stringify(new Lyrics({ publicId: '_', sections: sanitized }).toObject().sections)
}

/** True when the stored doc's projection is what Lyrics already holds. */
function docMatchesLyrics(state: Uint8Array, lyricsSections: unknown[], lyricsMode: CollabMeta['editorMode']): boolean {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    const mode = validEditorMode(doc.getMap('meta').get('editorMode')) ?? lyricsMode
    return mode === lyricsMode && canonicalSections(docToSections(doc)) === canonicalSections(lyricsSections)
  } finally {
    doc.destroy()
  }
}

async function mediaFor(uploadId: unknown): Promise<CollabMeta['media']> {
  const upload = uploadId ? await Upload.findById(uploadId).select('source uploadUrl').lean() : null
  return upload
    ? { source: upload.source, url: upload.uploadUrl ?? null, uploadId: String(upload._id) }
    : { source: null, url: null, uploadId: null }
}

type SongSource = {
  title?: string | null
  metadata?: { songName?: string | null; songArtist?: string | null; songAlbum?: string | null } | null
  coverImage?: string | null
}
type SongMeta = Pick<CollabMeta, 'title' | 'artist' | 'album' | 'cover'>

/** The doc's song fields as the seed derives them from a Project. */
function songMeta(project: SongSource): SongMeta {
  const md = project.metadata ?? {}
  return {
    title: md.songName || project.title || null,
    artist: md.songArtist || null,
    album: md.songAlbum || null,
    cover: project.coverImage || null,
  }
}

/**
 * A stored doc's song fields and media brought in line with the Project. While a session
 * is live the Project only changes through storeState's write-back (solo saves are refused
 * with collab_active), so a difference here means an edit made between sessions, which
 * must win over the stale doc instead of being written over by it.
 */
async function syncMetaFromProject(docName: string, state: Uint8Array): Promise<Uint8Array> {
  const project = await Project.findOne({ publicId: publicIdOf(docName) }).select('title metadata uploadId coverImage').lean<SongSource & { uploadId?: unknown }>()
  if (!project) return state
  const want = { ...songMeta(project), media: await mediaFor(project.uploadId) }
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    const meta = doc.getMap<unknown>('meta')
    const stale = (Object.keys(want) as Array<keyof typeof want>).filter((k) => JSON.stringify(meta.get(k) ?? null) !== JSON.stringify(want[k]))
    if (stale.length === 0) return state
    doc.transact(() => {
      for (const k of stale) meta.set(k, want[k])
    })
    const update = Y.encodeStateAsUpdate(doc)
    await CollabDoc.updateOne({ name: docName }, { $set: { state: Buffer.from(update) } })
    return update
  } finally {
    doc.destroy()
  }
}

const ALBUM_MAX = 500
const cleanText = (v: unknown, max: number): string => (typeof v === 'string' ? stripHtml(v).trim().slice(0, max) : '')

/**
 * The Project `$set` that writes the doc's title and album back to the fields the
 * seed read them from (songName when set, else title; songAlbum), sanitised and
 * capped like the Project schema, with the slug kept in step. Artist is not
 * written: songArtist is derived from structured credits and never free text.
 * Media and cover are not editable in a session (the owner saves those through
 * updateProject). A title or album the doc does not hold as a string (null,
 * absent) leaves the stored field alone: the seed writes null for an empty one.
 */
function metaWriteBack(project: SongSource, meta: SongMeta): Record<string, unknown> {
  const md = project.metadata ?? {}
  const $set: Record<string, unknown> = {}
  let title = project.title ?? ''
  let songName = md.songName ?? ''
  if (md.songName) {
    const next = cleanText(meta.title, PROJECT_SONG_NAME_MAX)
    if (next && next !== md.songName) $set['metadata.songName'] = songName = next
  } else {
    const next = cleanTitle(meta.title)
    if (next && next !== project.title) $set.title = title = next
  }
  if (typeof meta.album === 'string') {
    const album = cleanText(meta.album, ALBUM_MAX)
    if (album !== (md.songAlbum ?? '')) $set['metadata.songAlbum'] = album
  }
  if ('title' in $set || 'metadata.songName' in $set) {
    const nextMd = { songName, songArtist: md.songArtist ?? '' }
    if (!hasProjectIdentity(title, nextMd)) {
      delete $set.title
      delete $set['metadata.songName']
    } else {
      $set.slug = slugFor(title, nextMd)
    }
  }
  return $set
}

/**
 * Throws when the state did not persist. Otherwise resolves to whether Lyrics caught up with it:
 * false is a failed projection, where the CollabDoc holds the truth and the next store can retry.
 */
async function storeState(docName: string, document: Y.Doc, state: Buffer, log: FastifyBaseLogger): Promise<boolean> {
  const publicId = publicIdOf(docName)
  try {
    // State only. lyricsVersion is recorded below, and only once Lyrics really
    // reached that version: claiming it up front would let a failed projection
    // mask a later solo save (fetchState's `>=` check).
    await CollabDoc.updateOne({ name: docName }, { $set: { state } }, { upsert: true })
  } catch (err) {
    log.error({ err, docName }, 'collab: persisting doc state failed; keeping the doc in memory')
    // Rethrown on purpose: Hocuspocus catches a failed store (storeDocumentHooks)
    // and keeps the doc loaded instead of unloading, and losing, unpersisted edits.
    throw err
  }

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
    if (!lyrics) return true
    // A crash right here leaves lyricsVersion behind Lyrics; fetchState recognises
    // that case by content and keeps the doc (docMatchesLyrics).
    await CollabDoc.updateOne({ name: docName }, { $set: { lyricsVersion: lyrics.version } })
    const project = await Project.findOne({ publicId }).select('title metadata').lean<SongSource>()
    const metaSet = project ? metaWriteBack(project, docToMeta(document)) : {}
    await Project.updateOne(
      { publicId },
      { $set: { ...metaSet, contentUpdatedAt: new Date() }, $inc: { version: 1 } },
      { runValidators: true },
    )
    return true
  } catch (err) {
    // The CollabDoc already holds the truth; a projection failure must not keep the doc from persisting.
    log.error({ err, docName }, 'collab: projecting doc into Lyrics failed')
    return false
  }
}

/**
 * Deletes the stored doc of an ended session that is not loaded. A failed projection can leave it
 * ahead of Lyrics, and then it holds the only copy of those edits: they are projected first, and the
 * doc is kept if that fails. A doc behind Lyrics was overtaken by a solo save, so it is just dropped.
 */
async function removeStoredDoc(docName: string, log: FastifyBaseLogger): Promise<void> {
  const [stored, lyrics] = await Promise.all([CollabDoc.findOne({ name: docName }), readLyrics(publicIdOf(docName))])
  if (!stored) return
  if (lyrics && typeof stored.lyricsVersion === 'number' && stored.lyricsVersion >= (lyrics.version ?? 0)) {
    const state = new Uint8Array(stored.state)
    const sections = lyrics.sections?.length ? lyrics.sections : migrateLinesToSections(lyrics.lines ?? [])
    if (!docMatchesLyrics(state, sections, lyrics.editorMode ?? 'lrc')) {
      const doc = new Y.Doc()
      try {
        Y.applyUpdate(doc, state)
        if (!(await storeState(docName, doc, stored.state, log))) return
      } finally {
        doc.destroy()
      }
    }
  }
  await CollabDoc.deleteOne({ name: docName })
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

export type CollabServerOptions = { maxDocBytes?: number; storeRetryMs?: number; destroyTimeoutMs?: number }

export function createCollabServer(log: FastifyBaseLogger, opts: CollabServerOptions = {}): MountedCollabServer {
  const maxDocBytes = opts.maxDocBytes ?? DEFAULT_MAX_DOC_BYTES
  const destroyTimeoutMs = opts.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS
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
  /** Last lastActivityAt write per loaded doc. */
  const activityWrittenAt = new Map<string, number>()
  /**
   * Loaded docs whose last store failed, retried on a timer. 'state': nothing persisted those
   * edits, so the doc must not unload. 'projection': the CollabDoc has them and only Lyrics is behind.
   */
  const dirty = new Map<string, 'state' | 'projection'>()
  /**
   * Docs of an ended session: once the final store has landed and the doc unloads, the stored
   * doc is deleted. A later session then seeds from Lyrics rather than resuming this one.
   */
  const discardAfterStore = new Set<string>()
  /**
   * Tombstones of deleted projects: from the moment the discard starts until the stored doc is gone
   * (and the doc has unloaded), no connection is admitted, nothing loads and nothing is stored.
   * Each entry is removed when its discard finishes, so the set only holds deletes in progress.
   */
  const discarded = new Set<string>()
  /** Teardown in progress per doc. A new connection waits for it rather than attaching to a doc on its way out. */
  const settling = new Map<string, Promise<void>>()
  // Per document: awareness clientId -> owning subject, and connection -> the one clientId it may use.
  type AwarenessIds = { subjectOf: Map<number, string>; idOf: Map<string, number> }
  const awarenessIds = new Map<string, AwarenessIds>()
  const MAX_AWARENESS_IDS_PER_SUBJECT = 8

  // Binds clientId to subject. At the cap it evicts that subject's oldest binding that is both
  // unused by any live connection AND has no state left in the document's awareness; false when
  // none qualifies (Map order is insertion order, so oldest first).
  // Both conditions are needed because eviction frees the id for any other subject. A binding with
  // no live connection may still have state (its tab is mid-reconnect and the disconnect cleanup has
  // not run yet); freeing it would let another participant claim that id and speak over the state
  // peers still show for the original owner. Only once the state is gone is the id truly abandoned.
  function bindForSubject(doc: AwarenessIds, clientId: number, subject: string, awareness: Awareness): boolean {
    const mine = [...doc.subjectOf].filter(([, owner]) => owner === subject).map(([id]) => id)
    if (mine.length >= MAX_AWARENESS_IDS_PER_SUBJECT) {
      const live = new Set(doc.idOf.values())
      const present = awareness.getStates()
      const victim = mine.find((id) => !live.has(id) && !present.has(id))
      if (victim === undefined) return false
      doc.subjectOf.delete(victim)
    }
    doc.subjectOf.set(clientId, subject)
    return true
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    name: 'collab',
    quiet: true,
    debounce: STORE_DEBOUNCE_MS,
    maxDebounce: STORE_MAX_DEBOUNCE_MS,
    maxPendingDocuments: MAX_PENDING_DOCUMENTS,
    extensions: [
      new Database({
        fetch: async ({ documentName, context }) => {
          const state = discarded.has(documentName) ? null : await fetchState(documentName)
          if (state && !discarded.has(documentName)) return state
          setTimeout(() => (context as CollabContext).ws.close(CLOSE.session_ended, 'session_ended'), 0)
          // A plain object (no `message`) keeps Hocuspocus from logging it, as in onAuthenticate.
          // Its `reason` reaches the client as the permission-denied reason.
          throw { reason: 'session_ended' }
        },
        store: async ({ documentName, document, state }) => {
          if (discarded.has(documentName)) return
          let projected: boolean
          try {
            projected = await storeState(documentName, document, state, log)
          } catch (err) {
            dirty.set(documentName, 'state')
            throw err
          }
          if (projected) {
            dirty.delete(documentName)
            return
          }
          dirty.set(documentName, 'projection')
          // Rethrowing keeps the doc loaded. Mid-session the CollabDoc has the edits and that is
          // not needed; at the end of a session the CollabDoc is about to go.
          if (discardAfterStore.has(documentName)) throw new Error('collab: final projection failed')
        },
      }),
    ],

    async onAuthenticate({ documentName, requestHeaders, requestParameters, connectionConfig, context }) {
      await settling.get(documentName)?.catch(() => undefined)
      try {
        if (discarded.has(documentName)) throw new CollabAuthError('session_ended')
        const principal = await resolvePrincipal({
          cookieHeader: requestHeaders.get('cookie') ?? '',
          docName: documentName,
          ip: context.ip,
          // Browsers cannot set headers on a WebSocket, so the client passes it as a query param.
          deviceId: requestParameters.get('deviceId') ?? requestHeaders.get('x-device-id') ?? undefined,
          sessionId: requestParameters.get('sessionId') ?? undefined,
        })
        if (discarded.has(documentName)) throw new CollabAuthError('session_ended')
        // A new session reached a doc still waiting on its predecessor's final store: it carries on
        // from that doc (the same Yjs items), and the stored state stays.
        if (!settling.has(documentName)) discardAfterStore.delete(documentName)
        if (principal.role === 'viewer' || frozen.has(documentName)) connectionConfig.readOnly = true
        const now = Date.now()
        return {
          principal,
          connId: randomUUID(),
          awarenessTokens: { tokens: AWARENESS_RATE.burst, at: now },
          statelessTokens: { tokens: STATELESS_RATE.burst, at: now },
        }
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
      if (!ctx.principal || !ctx.connId || !ctx.statelessTokens) return
      // Before parsing: over the limit a message costs nothing. A client this far past any
      // real editing pace gets no answer, and a lock it asked for shows up as never granted.
      if (!takeToken(ctx.statelessTokens, STATELESS_RATE)) return
      const msg = parseMessage(payload)
      if (!msg) return
      const lines = document.getMap('lines')
      const holder = { conn: ctx.connId, subject: ctx.principal.subject, name: ctx.principal.name, colorIndex: ctx.principal.colorIndex }
      const deny = (lineId: string) => connection.sendStateless(JSON.stringify({ t: 'lock-denied', lineId }))
      let changed = false
      const countHeld = (held: ReturnType<typeof locks.snapshot>) => Object.values(held).filter((h) => h.conn === ctx.connId).length

      if (msg.t === 'lock') {
        if (connection.readOnly || !lines.has(msg.lineId)) return deny(msg.lineId)
        const held = locks.snapshot(documentName)
        if (held[msg.lineId]?.conn !== ctx.connId && countHeld(held) >= MAX_LOCKS_PER_CONN) return deny(msg.lineId)
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
        let count = countHeld(held)
        for (const lineId of msg.lineIds) {
          if (held[lineId]?.conn === ctx.connId) continue
          if (connection.readOnly || count >= MAX_LOCKS_PER_CONN || !lines.has(lineId) || !locks.acquire(documentName, lineId, holder).ok) deny(lineId)
          else {
            count++
            changed = true
          }
        }
      }
      if (changed) broadcastLocks(documentName)
    },

    // Awareness is client-authored, so the server decides who each awareness clientId is:
    // - a clientId belongs to the first subject that sends it, for the life of the loaded
    //   document (a reconnect or another tab of that subject may reuse it; nobody else may);
    // - a connection may speak for exactly one clientId per document, the first it sends;
    // - every state accepted carries the identity attested at authentication.
    // - a subject holds at most MAX_AWARENESS_IDS_PER_SUBJECT bindings per document; past that the
    //   oldest binding with no live connection and no remaining state is evicted (see bindForSubject),
    //   and with none to evict the new id is refused.
    // - a state above MAX_AWARENESS_STATE_CHARS, or any message past the connection's rate, is dropped.
    // Removing a closed connection's state is onDisconnect's job (see there).
    async beforeHandleAwareness({ documentName, context, states, removedClients, awareness }) {
      const connId = context?.connId
      const principal = context?.principal
      if (!connId || !principal || !context.awarenessTokens || !takeToken(context.awarenessTokens, AWARENESS_RATE)) {
        states.clear()
        removedClients.clear()
        return
      }
      let doc = awarenessIds.get(documentName)
      if (!doc) awarenessIds.set(documentName, (doc = { subjectOf: new Map(), idOf: new Map() }))
      const allowed = (clientId: number): boolean => {
        const mine = doc.idOf.get(connId)
        if (mine !== undefined && mine !== clientId) return false
        const owner = doc.subjectOf.get(clientId)
        return owner === undefined || owner === principal.subject
      }
      for (const clientId of [...states.keys()]) {
        const state = states.get(clientId)
        if (!allowed(clientId) || !state || typeof state !== 'object' || JSON.stringify(state).length > MAX_AWARENESS_STATE_CHARS) {
          states.delete(clientId)
          continue
        }
        if (!doc.subjectOf.has(clientId) && !bindForSubject(doc, clientId, principal.subject, awareness)) {
          states.delete(clientId)
          continue
        }
        doc.idOf.set(connId, clientId)
        state.user = { name: principal.name, colorIndex: principal.colorIndex, role: principal.role, subject: principal.subject, avatarUrl: principal.avatarUrl ?? null }
      }
      for (const clientId of [...removedClients]) if (!allowed(clientId) || doc.idOf.get(connId) !== clientId) removedClients.delete(clientId)
    },

    async onDisconnect({ documentName, context, document }) {
      if (!context.connId) return
      // The idle clock starts when people leave, not at their last edit.
      touchActivity(documentName)
      // Hocuspocus removes a closing connection's awareness only for ids that were `added` through it.
      // A reconnect with the same clientId arrives as `updated`, so it would be left behind as a ghost
      // for the 30 s awareness timeout: remove it here unless another live connection speaks for it.
      // (Residual: a half-open old connection closing after the reconnect makes Hocuspocus remove the
      // live id briefly; the live client re-asserts its state when it sees its own removal.)
      const ids = awarenessIds.get(documentName)
      const id = ids?.idOf.get(context.connId)
      ids?.idOf.delete(context.connId)
      if (ids && id !== undefined && document.awareness.getStates().has(id) && ![...ids.idOf.values()].includes(id)) {
        removeAwarenessStates(document.awareness, [id], null)
      }
      // The clientId stays bound to its subject (capped) until the document unloads.
      if (locks.releaseAllFor(documentName, context.connId).length > 0) broadcastLocks(documentName)
    },

    async afterLoadDocument({ documentName, document }) {
      const bytes = Y.encodeStateAsUpdate(document).byteLength
      docSize.set(documentName, { bytes, pending: 0 })
      if (bytes > maxDocBytes) frozen.add(documentName)
      else frozen.delete(documentName)
    },

    // Covers the first load after a restart, where auth ran before the size was known.
    // It also greets the connection: guests have no other way to learn their own
    // identity or conn id, which the client compares against lock holders.
    async connected({ documentName, connection, context }) {
      if (discarded.has(documentName)) return drop(connection, CLOSE.session_ended, 'session-ended')
      if (frozen.has(documentName)) connection.readOnly = true
      const { principal, connId } = context
      if (!principal || !connId) return
      touchActivity(documentName)
      connection.sendStateless(JSON.stringify({
        t: 'hello', conn: connId, subject: principal.subject, name: principal.name, avatarUrl: principal.avatarUrl ?? null,
        colorIndex: principal.colorIndex, role: principal.role, sessionId: principal.sessionId,
      }))
      connection.sendStateless(locksMessage(documentName))
    },

    // The 5 MiB ws frame cap bounds one message, not the doc: without this, editors
    // could grow a doc past Mongo's 16 MB BSON limit, after which every store fails.
    // An exact re-measure costs a full encode, so it runs every RECHECK_BYTES of
    // incoming updates, or on every change once the doc is near the cap.
    async onChange({ documentName, document, update, connection, context }) {
      recordContributor(documentName, connection, context)
      if (connection) touchActivity(documentName)
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
      // Every connection, not just the sender: another writer already connected
      // could otherwise keep adding up to a frame each. readOnly takes effect for
      // messages already queued, so nothing more lands. Writers are then reconnected
      // so their providers learn the read-only scope instead of editing into the void.
      for (const conn of document.getConnections()) {
        const wasWritable = !conn.readOnly
        conn.readOnly = true
        if (wasWritable || conn === connection) drop(conn, CLOSE.tooLarge, 'doc-too-large')
      }
    },

    // Hocuspocus only keeps a doc for the store that just failed: once nothing is pending, the
    // last client leaving unloads it. Refusing here is what makes a failed store survive that.
    async beforeUnloadDocument({ documentName }) {
      if (isUnstored(documentName)) throw { reason: 'unstored' }
    },

    async afterUnloadDocument({ documentName }) {
      awarenessIds.delete(documentName)
      locks.clearDoc(documentName)
      docSize.delete(documentName)
      clearHandled(documentName)
      if (!settling.has(documentName)) discarded.delete(documentName)
      dirty.delete(documentName)
      activityWrittenAt.delete(documentName)
      if (discardAfterStore.delete(documentName)) {
        // Failing leaves the stored doc for the next session to resume; the epoch still refuses stale tabs.
        await CollabDoc.deleteOne({ name: documentName }).catch((err: unknown) => log.error({ err, documentName }, 'collab: deleting the stored doc failed'))
      }
      if (onAllUnloaded && hocuspocus.getDocumentsCount() === 0) onAllUnloaded()
    },
  })

  // Credits a non-owner whose connection applied a change. Server-internal changes (seeding,
  // projection, a DirectConnection) arrive with no connection and are never credited. Fire and
  // forget: a failed write must not slow or break sync, and is retried on the subject's next change.
  function recordContributor(docName: string, connection: Connection | undefined, context: CollabContext | undefined): void {
    const principal = context?.principal
    if (!connection || connection.readOnly || !principal || principal.role === 'owner' || principal.role === 'viewer') return
    const seen = handledSubjects(docName)
    if (seen.has(principal.subject)) return
    seen.add(principal.subject)
    creditCollaborator(publicIdOf(docName), principal).catch((err) => {
      seen.delete(principal.subject)
      log.error({ err, docName, subject: principal.subject }, 'collab: recording collaborator credit failed')
    })
  }

  // Fire and forget, like recordContributor: a failed write only makes the session look idler.
  function touchActivity(docName: string): void {
    const now = Date.now()
    if (now - (activityWrittenAt.get(docName) ?? 0) < ACTIVITY_THROTTLE_MS) return
    activityWrittenAt.set(docName, now)
    CollabSession.updateOne(
      { publicId: publicIdOf(docName), endedAt: null },
      { $set: { lastActivityAt: new Date() } },
      { timestamps: false },
    ).catch((err: unknown) => {
      activityWrittenAt.delete(docName)
      log.error({ err, docName }, 'collab: recording session activity failed')
    })
  }

  function locksMessage(docName: string): string {
    const locksOut: Record<string, { holderConn: string; subject: string; name: string; colorIndex: number }> = {}
    for (const [lineId, h] of Object.entries(locks.snapshot(docName))) {
      locksOut[lineId] = { holderConn: h.conn, subject: h.subject, name: h.name, colorIndex: h.colorIndex }
    }
    return JSON.stringify({ t: 'locks', locks: locksOut })
  }

  function broadcastLocks(docName: string): void {
    hocuspocus.documents.get(docName)?.broadcastStateless(locksMessage(docName))
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

  function connectionsEverywhere(match: (c: CollabContext) => boolean): Connection[] {
    return [...hocuspocus.documents.values()].flatMap((d) => d.getConnections()).filter((c) => match(c.context as CollabContext))
  }

  /** Runs now any pending debounced store of this doc, after one already in flight. Never rejects. */
  function storeNow(doc: Document): Promise<unknown> {
    return hocuspocus.storeDocumentHooks(doc, {
      instance: hocuspocus,
      clientsCount: doc.getConnectionsCount(),
      document: doc,
      documentName: doc.name,
      lastContext: {} as CollabContext,
      lastTransactionOrigin: null,
    }, true)
  }

  function isUnstored(docName: string): boolean {
    if (discarded.has(docName)) return false
    const failed = dirty.get(docName)
    return failed === 'state' || (failed !== undefined && discardAfterStore.has(docName))
  }

  function retryDirtyStores(): void {
    for (const docName of dirty.keys()) {
      const doc = hocuspocus.documents.get(docName)
      if (!doc) dirty.delete(docName)
      else if (!hocuspocus.debouncer.isCurrentlyExecuting(`onStoreDocument-${docName}`)) void storeNow(doc)
    }
  }

  /** Serialises teardowns of one doc and publishes the current one to the auth gate. */
  function settle(docName: string, work: () => Promise<void>): Promise<void> {
    const run: Promise<void> = (settling.get(docName)?.catch(() => undefined) ?? Promise.resolve())
      .then(work)
      .finally(() => {
        if (settling.get(docName) === run) settling.delete(docName)
      })
    settling.set(docName, run)
    return run
  }

  /** The doc as loaded, waiting out a load in progress. */
  async function loadedDoc(docName: string): Promise<Document | undefined> {
    await hocuspocus.loadingDocuments.get(docName)?.catch(() => undefined)
    return hocuspocus.documents.get(docName)
  }

  /**
   * Closes the doc's connections until it has unloaded. A connection whose auth was already
   * past the gate can still attach after the first pass; it is closed by a later one.
   * An unstored doc stays loaded for the retry timer, so there is nothing to wait for.
   */
  async function closeUntilUnloaded(docName: string, code: number, reason: string): Promise<void> {
    const deadline = Date.now() + DESTROY_TIMEOUT_MS
    while ((hocuspocus.documents.has(docName) || hocuspocus.unloadingDocuments.has(docName)) && Date.now() < deadline) {
      for (const c of hocuspocus.documents.get(docName)?.getConnections() ?? []) drop(c, code, reason)
      if (isUnstored(docName)) return
      await new Promise((r) => setTimeout(r, UNLOAD_POLL_MS))
    }
  }

  const sweepTimer = setInterval(() => {
    for (const docName of locks.sweep()) broadcastLocks(docName)
  }, SWEEP_MS)
  sweepTimer.unref()

  const storeRetryTimer = setInterval(retryDirtyStores, opts.storeRetryMs ?? DEFAULT_STORE_RETRY_MS)
  storeRetryTimer.unref()

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
      const doc = hocuspocus.documents.get(docName)
      if (doc) {
        const ids = awarenessIds.get(docName)
        if (ids) {
          const toRemove: number[] = []
          for (const [clientId, owner] of ids.subjectOf.entries()) {
            if (owner === subject) {
              toRemove.push(clientId)
              ids.subjectOf.delete(clientId)
            }
          }
          for (const [connId, clientId] of ids.idOf.entries()) {
            if (toRemove.includes(clientId)) {
              ids.idOf.delete(connId)
            }
          }
          if (toRemove.length > 0) {
            removeAwarenessStates(doc.awareness, toRemove, null)
          }
        }
        doc.broadcastStateless(JSON.stringify({ t: 'kicked', subject }))
      }
      for (const c of connectionsOf(docName, (ctx) => ctx.principal?.subject === subject)) drop(c, CLOSE.kicked, 'kicked')
      broadcastLocks(docName)
    },

    reconnectSubject(docName, subject) {
      for (const c of connectionsOf(docName, (ctx) => ctx.principal?.subject === subject)) drop(c, CLOSE.roleChanged, 'role-changed')
    },

    hasConnections(docName) {
      return (hocuspocus.documents.get(docName)?.getConnectionsCount() ?? 0) > 0
    },

    closeUserEverywhere(userId) {
      for (const c of connectionsEverywhere((ctx) => ctx.principal?.accountId === userId)) drop(c, CLOSE.forbidden, 'forbidden')
    },

    reauthUserEverywhere(userId) {
      for (const c of connectionsEverywhere((ctx) => ctx.principal?.accountId === userId)) drop(c, CLOSE.reauth, 'reauth')
    },

    reauthIpEverywhere(ip) {
      for (const c of connectionsEverywhere((ctx) => ctx.ip === ip)) drop(c, CLOSE.reauth, 'reauth')
    },

    endSession(docName) {
      return settle(docName, async () => {
        const doc = await loadedDoc(docName)
        if (doc) {
          discardAfterStore.add(docName)
          // Read-only first, so the final store holds everything anyone will ever have sent,
          // and "ended" is only said once it has been attempted.
          for (const c of doc.getConnections()) c.readOnly = true
          await storeNow(doc)
          doc.broadcastStateless(JSON.stringify({ t: 'session-ended' }))
          await closeUntilUnloaded(docName, CLOSE.session_ended, 'session-ended')
        } else {
          await removeStoredDoc(docName, log).catch((err: unknown) => log.error({ err, docName }, 'collab: removing the stored doc failed'))
        }
        locks.clearDoc(docName)
        frozen.delete(docName) // a later session re-seeds from Lyrics
      })
    },

    isFlushingEnd(docName) {
      return discardAfterStore.has(docName) && dirty.has(docName)
    },

    discardSession(docName) {
      // Up front, not in the queued work: a load already in flight checks it when its read returns.
      discarded.add(docName)
      return settle(docName, async () => {
        try {
          const doc = await loadedDoc(docName)
          if (doc) {
            // The store is now a no-op, so this only waits out one already writing:
            // that write must land before the delete below.
            await storeNow(doc)
            doc.broadcastStateless(JSON.stringify({ t: 'session-ended' }))
            await closeUntilUnloaded(docName, CLOSE.session_ended, 'session-ended')
          }
          locks.clearDoc(docName)
          frozen.delete(docName)
          await CollabDoc.deleteOne({ name: docName })
        } finally {
          // From here fetchState refuses by itself: the project is gone. A doc that outlived
          // the wait keeps its tombstone, and afterUnloadDocument clears it.
          if (!hocuspocus.documents.has(docName)) discarded.delete(docName)
        }
      })
    },

    async destroy() {
      clearInterval(sweepTimer)
      // Same sequence as @hocuspocus/server's Server.destroy(): close every
      // connection, run pending debounced stores now, wait for the unloads.
      await new Promise<void>((resolve) => {
        // Docs still unstored keep this from resolving early, so the retry timer gets the whole bound.
        const timer = setTimeout(resolve, destroyTimeoutMs)
        timer.unref()
        onAllUnloaded = () => {
          clearTimeout(timer)
          resolve()
        }
        if (hocuspocus.getDocumentsCount() === 0) onAllUnloaded()
        hocuspocus.closeConnections()
        hocuspocus.flushPendingStores()
        retryDirtyStores()
      })
      clearInterval(storeRetryTimer)
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
