import { Server } from 'socket.io';
import { verifyToken } from '../lib/jwt';
import { bindUserSocket, unbindUserSocket } from './userRegistry';

/**
 * Lets logged-in clients register their socket for live notifications.
 * Attaches to the same io instance as the SoulLink handlers.
 */
export function registerUserSocket(io: Server): void {
  io.on('connection', socket => {
    socket.on('user:join', (data: { token?: string }) => {
      const payload = data?.token ? verifyToken(data.token) : null;
      if (!payload) return;
      bindUserSocket(payload.userId, socket.id);
    });

    socket.on('disconnect', () => {
      unbindUserSocket(socket.id);
    });
  });
}
