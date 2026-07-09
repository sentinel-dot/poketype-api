import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { Server } from 'socket.io';
import { createRoom, getRoom, updateRoomSettings, inviteToRoom } from '../controllers/soullink/rooms';
import { joinRoom, leaveRoom } from '../controllers/soullink/join';
import { updateSlot, clearSlot, clearAllSlots, updateDeathCount } from '../controllers/soullink/teamSlots';
import { addEncounter, removeEncounter, getFamilyKey } from '../controllers/soullink/encounters';
import { getLiveKitToken } from '../controllers/soullink/livekit';
import { optionalAuth, requireAuth } from '../middleware/auth';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

export function createSoulLinkRouter(io: Server): Router {
  const router = Router();

  // Room CRUD (optionalAuth links a logged-in host to the room/seat)
  router.post('/rooms', optionalAuth, asyncHandler(createRoom));
  router.get('/rooms/:roomCode', asyncHandler(getRoom));
  router.patch('/rooms/:roomCode/settings', optionalAuth, asyncHandler(updateRoomSettings));

  // Invite a friend (auth required)
  router.post(
    '/rooms/:roomCode/invite',
    requireAuth,
    asyncHandler((req, res) => inviteToRoom(req, res, io)),
  );

  // Seat management
  router.post('/rooms/:roomCode/join', optionalAuth, asyncHandler(joinRoom));
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
  router.delete(
    '/rooms/:roomCode/seats/:seatId/team',
    asyncHandler((req, res) => clearAllSlots(req, res, io)),
  );

  // Death counter (per seat)
  router.patch(
    '/rooms/:roomCode/seats/:seatId/deaths',
    asyncHandler((req, res) => updateDeathCount(req, res, io)),
  );

  // Dupes registry / encounters
  router.post('/rooms/:roomCode/encounters', asyncHandler((req, res) => addEncounter(req, res, io)));
  router.delete(
    '/rooms/:roomCode/encounters/:familyKey',
    asyncHandler((req, res) => removeEncounter(req, res, io)),
  );
  router.get('/pokemon/:id/family', asyncHandler(getFamilyKey));

  // LiveKit token
  router.post('/rooms/:roomCode/livekit-token', asyncHandler(getLiveKitToken));

  return router;
}
