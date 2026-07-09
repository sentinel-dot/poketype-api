import jwt from 'jsonwebtoken';

const JWT_SECRET: string = process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me';
const JWT_EXPIRES_IN = '30d';

export interface JwtPayload {
  userId: string;
  username: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === 'object' && decoded && 'userId' in decoded && 'username' in decoded) {
      return { userId: String((decoded as JwtPayload).userId), username: String((decoded as JwtPayload).username) };
    }
    return null;
  } catch {
    return null;
  }
}
