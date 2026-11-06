import type { Server } from 'socket.io';

let _io: Server | null = null;

export function setIO(io: Server | null): void {
  _io = io;
}

/**
 * Room holding the sockets of one login session (token family). Revocation notices go here,
 * not to the whole `user:` room, so signing out one device never signs out the others.
 */
export function sessionRoom(familyId: string): string {
  return `session:${familyId}`;
}

export function getIO(): Server {
  if (!_io) throw new Error('Socket.io not initialized');
  return _io;
}
