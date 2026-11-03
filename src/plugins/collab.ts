import type { FastifyInstance } from 'fastify'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import fp from 'fastify-plugin'
import proxyAddr from '@fastify/proxy-addr'
import { WebSocketServer } from 'ws'
import { parseAllowedOrigins } from '../config/allowed-origins.js'
import { getEnv, toFastifyTrustProxy } from '../config/env.js'
import { createCollabServer } from '../modules/collab/collab.server.js'

const COLLAB_PATH = '/collab'
/** Socket.IO's engine.io claims upgrades under this prefix (plugins/socket.ts). */
const SOCKET_IO_PREFIX = '/socket.io/'
/** Applies before authentication, so it bounds what one unauthenticated frame can make us buffer. */
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024
/** Bucket entries kept before idle (full) ones are pruned. */
const MAX_TRACKED_IPS = 10_000

export type CollabPluginOptions = {
  /** Upgrade attempts per IP per minute (token bucket). */
  upgradesPerMinute?: number
  /** Concurrently open /collab sockets per IP. */
  maxConnectionsPerIp?: number
  /** Encoded Y.Doc size cap, see collab.server.ts. */
  maxDocBytes?: number
}

function refuse(socket: Duplex, status: 403 | 404 | 429): void {
  const text = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Too Many Requests'
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } finally {
    socket.destroy()
  }
}

/**
 * The client IP exactly as Fastify's request.ip derives it: raw upgrade events
 * never reach a Fastify request, so this mirrors the app's TRUST_PROXY instead of
 * reading X-Forwarded-For directly (which any direct caller can write).
 */
function makeClientIp(): (req: IncomingMessage) => string | undefined {
  const tp = toFastifyTrustProxy(getEnv().TRUST_PROXY)
  if (tp === false) return (req) => req.socket.remoteAddress
  const trust = tp === true ? () => true : typeof tp === 'function' ? tp : proxyAddr.compile(tp)
  return (req) => proxyAddr.all(req, trust).at(-1)
}

/**
 * Per-IP admission for /collab upgrades. Fastify's rate limiter never sees
 * upgrade events, and Origin is forgeable outside a browser, so without this a
 * single host could open sockets without bound. Keyed on IP only: X-Device-Id is
 * client-supplied (see security.md, rate limiting).
 */
function makeAdmission(perMinute: number, maxConcurrent: number) {
  const buckets = new Map<string, { tokens: number; at: number }>()
  const open = new Map<string, number>()
  const refillPerMs = perMinute / 60_000

  function prune(now: number): void {
    if (buckets.size <= MAX_TRACKED_IPS) return
    for (const [ip, b] of buckets) {
      if (b.tokens + (now - b.at) * refillPerMs >= perMinute && !open.has(ip)) buckets.delete(ip)
    }
  }

  return {
    /** Takes a token and a connection slot, or returns false. */
    admit(ip: string): boolean {
      const now = Date.now()
      prune(now)
      const b = buckets.get(ip) ?? { tokens: perMinute, at: now }
      b.tokens = Math.min(perMinute, b.tokens + (now - b.at) * refillPerMs)
      b.at = now
      buckets.set(ip, b)
      if (b.tokens < 1 || (open.get(ip) ?? 0) >= maxConcurrent) return false
      b.tokens -= 1
      open.set(ip, (open.get(ip) ?? 0) + 1)
      return true
    },
    release(ip: string): void {
      const n = (open.get(ip) ?? 1) - 1
      if (n <= 0) open.delete(ip)
      else open.set(ip, n)
    },
  }
}

/**
 * Mounts the Hocuspocus collab endpoint at `/collab` on the Fastify HTTP server.
 *
 * Owns every non-Socket.IO upgrade: Socket.IO runs with `destroyUpgrade: false`
 * so it leaves `/collab` alone, which means stray upgrades to any other path
 * are only ever closed here. Register after `mongoose` so this plugin's onClose
 * (which flushes pending stores) runs before the Mongo connection closes;
 * Fastify runs onClose hooks in reverse registration order.
 */
async function collabPlugin(fastify: FastifyInstance, opts: CollabPluginOptions): Promise<void> {
  const origins = new Set(parseAllowedOrigins(process.env.CORS_ORIGIN))
  const clientIp = makeClientIp()
  const admission = makeAdmission(opts.upgradesPerMinute ?? 30, opts.maxConnectionsPerIp ?? 20)
  const collab = createCollabServer(fastify.log, { maxDocBytes: opts.maxDocBytes })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })

  // Synchronous listener on a raw socket: anything thrown here is an uncaught
  // exception that takes the process down, so the whole body is guarded.
  fastify.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      // No `new URL()`: request targets like `//` or `//:99999/` make it throw.
      const pathname = (req.url ?? '/').split('?')[0]
      if (pathname.startsWith(SOCKET_IO_PREFIX)) return
      if (pathname !== COLLAB_PATH) return refuse(socket, 404)
      // Browsers always send Origin on a WebSocket handshake; a missing one is not a browser we serve.
      const origin = req.headers.origin
      if (!origin || !origins.has(origin)) return refuse(socket, 403)
      const ip = clientIp(req)
      if (!ip) return refuse(socket, 403)
      if (!admission.admit(ip)) return refuse(socket, 429)
      // The slot is held for the socket's whole life, handshake failures included.
      socket.once('close', () => admission.release(ip))
      wss.handleUpgrade(req, socket, head, (ws) => {
        try {
          collab.handleSocket(ws, req, ip)
        } catch (err) {
          fastify.log.error({ err }, 'collab: failed to attach socket')
          ws.terminate()
        }
      })
    } catch (err) {
      fastify.log.error({ err }, 'collab: upgrade handling failed')
      socket.destroy()
    }
  })

  fastify.addHook('onClose', async () => {
    await collab.destroy()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
}

export default fp(collabPlugin, { name: 'collab' })
