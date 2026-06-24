const userToSockets = new Map<string, Set<string>>();
const socketToUser = new Map<string, string>();

/** Returns true if this is the first socket for the user (newly online). */
export function setOnline(userId: string, socketId: string): boolean {
  socketToUser.set(socketId, userId);
  let sockets = userToSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    userToSockets.set(userId, sockets);
  }
  const wasOffline = sockets.size === 0;
  sockets.add(socketId);
  return wasOffline;
}

/** Returns userId + whether this was the last socket (now offline), or null if unknown socket. */
export function setOffline(socketId: string): { userId: string; lastSocket: boolean } | null {
  const userId = socketToUser.get(socketId);
  if (!userId) return null;
  socketToUser.delete(socketId);
  const sockets = userToSockets.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      userToSockets.delete(userId);
      return { userId, lastSocket: true };
    }
  }
  return { userId, lastSocket: false };
}

export function isOnline(userId: string): boolean {
  return (userToSockets.get(userId)?.size ?? 0) > 0;
}

export function getOnlineUserIds(): string[] {
  return Array.from(userToSockets.keys());
}
