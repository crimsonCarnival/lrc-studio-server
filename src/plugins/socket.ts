import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { setIO } from '../socket/socket.manager.js';

async function socketPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = process.env.CORS_ORIGIN!
    .split(',')
    .map((o: string) => o.trim());

  const io = new Server(fastify.server, {
    cors: {
      origin: origins,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  setIO(io);
  fastify.addHook('onClose', () => new Promise<void>(res => io.close(() => res())));

  fastify.addHook('onListen', async () => {
    io.on('connection', (socket) => {
      fastify.log.info({ socketId: socket.id }, 'socket connected');

      socket.on('join:user', (userId: string) => {
        if (typeof userId === 'string' && userId.length > 0) {
          socket.join(`user:${userId}`);
        }
      });

      socket.on('join:project', (publicId: string) => {
        if (typeof publicId === 'string' && publicId.length > 0) {
          socket.join(`project:${publicId}`);
        }
      });

      socket.on('leave:project', (publicId: string) => {
        socket.leave(`project:${publicId}`);
      });

      socket.on('disconnect', (reason) => {
        fastify.log.info({ socketId: socket.id, reason }, 'socket disconnected');
      });
    });
  });
}

export default fp(socketPlugin, { name: 'socket', dependencies: ['cors'] });
