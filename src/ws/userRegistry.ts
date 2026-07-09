import { Server } from 'socket.io';

/**
 * Tracks which socket ids belong to which logged-in user, so notifications can
 * be pushed live to every open tab. In-memory only (rebuilt on reconnect).
 */
const userToSockets = new Map<string, Set<string>>();
const socketToUser = new Map<string, string>();

export function bindUserSocket(userId: string, socketId: string): void {
  socketToUser.set(socketId, userId);
  let set = userToSockets.get(userId);
  if (!set) {
    set = new Set();
    userToSockets.set(userId, set);
  }
  set.add(socketId);
}

export function unbindUserSocket(socketId: string): void {
  const userId = socketToUser.get(socketId);
  if (!userId) return;
  socketToUser.delete(socketId);
  const set = userToSockets.get(userId);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) userToSockets.delete(userId);
  }
}

export function isUserOnline(userId: string): boolean {
  return userToSockets.has(userId);
}

/** Emits an event to every socket the given user currently has open. */
export function emitToUser(io: Server, userId: string, event: string, payload: unknown): void {
  const set = userToSockets.get(userId);
  if (!set) return;
  for (const socketId of set) {
    io.to(socketId).emit(event, payload);
  }
}
