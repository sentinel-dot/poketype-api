import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { listNotifications, markRead, markAllRead } from '../controllers/notifications';
import { requireAuth } from '../middleware/auth';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

export function createNotificationsRouter(): Router {
  const router = Router();

  router.use(requireAuth);
  router.get('/', asyncHandler(listNotifications));
  router.post('/:id/read', asyncHandler(markRead));
  router.post('/read-all', asyncHandler(markAllRead));

  return router;
}
