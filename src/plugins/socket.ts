import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import fastifySocketIO from 'fastify-socket.io';
import { setIO } from '../socket/socket.manager.js';

async function socketPlugin(fastify: FastifyInstance): Promise<void> {
  const origins = process.env.CORS_ORIGIN!
    .split(',')
    .map((o: string) => o.trim());

  // @ts-ignore – fastify-socket.io types target Fastify 4.x but runtime is compatible with 5.x
  await fastify.register(fastifySocketIO, {
    cors: {
      origin: origins,
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  fastify.ready(() => {
    setIO((fastify as any).io);

    (fastify as any).io.on('connection', (socket: any) => {
      fastify.log.info({ socketId: socket.id }, 'socket connected');

      socket.on('join:user', (userId: string) => {
        if (typeof userId === 'string' && userId.length > 0) {
          socket.join(`user:${userId}`);
        }
      });

      socket.on('join:project', (projectId: string) => {
        if (typeof projectId === 'string' && projectId.length > 0) {
          socket.join(`project:${projectId}`);
        }
      });

      socket.on('leave:project', (projectId: string) => {
        socket.leave(`project:${projectId}`);
      });

      socket.on('disconnect', () => {
        fastify.log.info({ socketId: socket.id }, 'socket disconnected');
      });
    });
  });
}

export default fp(socketPlugin, { name: 'socket', dependencies: ['cors'] });
