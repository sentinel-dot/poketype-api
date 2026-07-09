import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { register, login, me, updateProfile, myRooms } from '../controllers/auth';
import { requireAuth } from '../middleware/auth';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// Throttle credential endpoints to blunt brute-force / enumeration attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Versuche. Bitte später erneut versuchen.' },
});

export function createAuthRouter(): Router {
  const router = Router();

  router.post('/register', authLimiter, asyncHandler(register));
  router.post('/login', authLimiter, asyncHandler(login));
  router.get('/me', requireAuth, asyncHandler(me));
  router.patch('/me', requireAuth, asyncHandler(updateProfile));
  router.get('/me/rooms', requireAuth, asyncHandler(myRooms));

  return router;
}
