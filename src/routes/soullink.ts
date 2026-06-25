import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { Server } from 'socket.io';
import { createRoom, getRoom } from '../controllers/soullink/rooms';
import { joinRoom, leaveRoom } from '../controllers/soullink/join';
import { updateSlot, clearSlot } from '../controllers/soullink/teamSlots';
import { getLiveKitToken } from '../controllers/soullink/livekit';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

export function createSoulLinkRouter(io: Server): Router {
  const router = Router();

  // Room CRUD
  router.post('/rooms', asyncHandler(createRoom));
  router.get('/rooms/:roomCode', asyncHandler(getRoom));

  // Seat management
  router.post('/rooms/:roomCode/join', asyncHandler(joinRoom));
  router.post('/rooms/:roomCode/leave', asyncHandler((req, res) => leaveRoom(req, res, io)));

  // Team slot updates
  router.patch(
    '/rooms/:roomCode/seats/:seatId/team/:slot',
    asyncHandler((req, res) => updateSlot(req, res, io)),
  );
  router.delete(
    '/rooms/:roomCode/seats/:seatId/team/:slot',
    asyncHandler((req, res) => clearSlot(req, res, io)),
  );

  // LiveKit token
  router.post('/rooms/:roomCode/livekit-token', asyncHandler(getLiveKitToken));

  return router;
}
