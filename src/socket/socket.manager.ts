// @ts-expect-error socket.io not yet installed - stub for socket.io plan
import type { Server } from 'socket.io';

let io: Server | null = null;

export function setIO(instance: Server): void {
  io = instance;
}

export function getIO(): Server {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}
