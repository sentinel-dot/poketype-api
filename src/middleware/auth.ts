import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../lib/jwt';

/** Request augmented with the authenticated user (set by the auth middleware). */
export interface AuthedRequest extends Request {
  auth?: JwtPayload;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Populates `req.auth` when a valid token is present, but never rejects.
 * Use for endpoints that behave differently for guests vs. logged-in users.
 */
export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.auth = payload;
  }
  next();
}

/** Rejects with 401 unless a valid token is present. */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return;
  }
  req.auth = payload;
  next();
}
