import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { Server } from 'socket.io';
import {
  searchUsers,
  listFriends,
  sendRequest,
  acceptRequest,
  declineRequest,
  removeFriend,
} from '../controllers/friends';
import { requireAuth } from '../middleware/auth';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

export function createFriendsRouter(io: Server): Router {
  const router = Router();

  router.use(requireAuth);
  router.get('/search', asyncHandler(searchUsers));
  router.get('/', asyncHandler(listFriends));
  router.post('/request', asyncHandler((req, res) => sendRequest(io, req, res)));
  router.post('/accept', asyncHandler((req, res) => acceptRequest(io, req, res)));
  router.post('/decline', asyncHandler(declineRequest));
  router.delete('/:userId', asyncHandler(removeFriend));

  return router;
}
