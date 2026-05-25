import type { Server } from 'socket.io';

let _io: Server | null = null;

export function setIO(io: Server | null): void {
  _io = io;
}

export function getIO(): Server {
  if (!_io) throw new Error('Socket.io not initialized');
  return _io;
}
