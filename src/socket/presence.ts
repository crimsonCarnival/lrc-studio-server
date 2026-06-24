const userToSockets = new Map<string, Set<string>>();
const socketToUser = new Map<string, string>();

export interface UserActivity {
  projectTitle: string;
  songName: string;
  publicId: string;
}

const activityStore = new Map<string, UserActivity>();

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
      activityStore.delete(userId);
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

export function setActivity(userId: string, activity: UserActivity): void {
  activityStore.set(userId, activity);
}

export function clearActivity(userId: string): void {
  activityStore.delete(userId);
}

export function getUserForSocket(socketId: string): string | undefined {
  return socketToUser.get(socketId);
}

export function getActivity(userId: string): UserActivity | null {
  return activityStore.get(userId) ?? null;
}

export function getOnlineUsersWithActivity(): Array<{ userId: string; activity: UserActivity | null }> {
  return Array.from(userToSockets.keys()).map(userId => ({
    userId,
    activity: activityStore.get(userId) ?? null,
  }));
}
