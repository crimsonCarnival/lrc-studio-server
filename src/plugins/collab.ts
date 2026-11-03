import type { FastifyInstance } from 'fastify'
import type { Duplex } from 'stream'
import fp from 'fastify-plugin'
import { WebSocketServer } from 'ws'
import { parseAllowedOrigins } from '../config/allowed-origins.js'
import { createCollabServer } from '../modules/collab/collab.server.js'

const COLLAB_PATH = '/collab'
/** Socket.IO's engine.io claims upgrades under this prefix (plugins/socket.ts). */
const SOCKET_IO_PREFIX = '/socket.io/'
/** Applies before authentication, so it bounds what one unauthenticated frame can make us buffer. */
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024

function refuse(socket: Duplex, status: 403 | 404): void {
  const text = status === 403 ? 'Forbidden' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

/**
 * Mounts the Hocuspocus collab endpoint at `/collab` on the Fastify HTTP server.
 *
 * Owns every non-Socket.IO upgrade: Socket.IO runs with `destroyUpgrade: false`
 * so it leaves `/collab` alone, which means stray upgrades to any other path
 * are only ever closed here. Register after `mongoose` so this plugin's onClose
 * (which flushes pending stores) runs before the Mongo connection closes —
 * Fastify runs onClose hooks in reverse registration order.
 */
async function collabPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = new Set(parseAllowedOrigins(process.env.CORS_ORIGIN))
  const collab = createCollabServer(fastify.log)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })

  fastify.server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname.startsWith(SOCKET_IO_PREFIX)) return
    if (pathname !== COLLAB_PATH) return refuse(socket, 404)
    // Browsers always send Origin on a WebSocket handshake; a missing one is not a browser we serve.
    const origin = req.headers.origin
    if (!origin || !origins.has(origin)) return refuse(socket, 403)
    wss.handleUpgrade(req, socket, head, (ws) => collab.handleSocket(ws, req))
  })

  fastify.addHook('onClose', async () => {
    await collab.destroy()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
}

export default fp(collabPlugin, { name: 'collab' })
