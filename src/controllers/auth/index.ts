import { Response } from 'express';
import { RowDataPacket } from 'mysql2';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import pool from '../../db/connection';
import { signToken } from '../../lib/jwt';
import { AuthedRequest } from '../../middleware/auth';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const BCRYPT_COST = 10;

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  avatar: string | null;
  created_at: string;
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatar: row.avatar,
    createdAt: row.created_at,
  };
}

export async function register(req: AuthedRequest, res: Response): Promise<void> {
  const username = String(req.body?.username ?? '').trim();
  const displayNameRaw = String(req.body?.displayName ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: 'Benutzername: 3–30 Zeichen, nur Buchstaben, Zahlen und _.' });
    return;
  }
  if (password.length < 8 || password.length > 200) {
    res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein.' });
    return;
  }
  const displayName = displayNameRaw.length > 0 ? displayNameRaw.slice(0, 50) : username;

  const [existing] = await pool.query<UserRow[]>(
    'SELECT id FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  if (existing.length > 0) {
    res.status(409).json({ error: 'Benutzername ist bereits vergeben.' });
    return;
  }

  const id = uuid();
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await pool.query(
    'INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
    [id, username, displayName, passwordHash],
  );

  const token = signToken({ userId: id, username });
  res.status(201).json({
    token,
    user: { id, username, displayName, avatar: null },
  });
}

export async function login(req: AuthedRequest, res: Response): Promise<void> {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');

  if (!username || !password) {
    res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
    return;
  }

  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  const user = rows[0];

  // Constant-ish response: always run a compare to avoid user enumeration timing.
  const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) {
    res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
    return;
  }

  const token = signToken({ userId: user.id, username: user.username });
  res.json({ token, user: publicUser(user) });
}

export async function me(req: AuthedRequest, res: Response): Promise<void> {
  const userId = req.auth!.userId;
  const [rows] = await pool.query<UserRow[]>(
    'SELECT * FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Benutzer nicht gefunden.' });
    return;
  }
  res.json({ user: publicUser(rows[0]) });
}

export async function updateProfile(req: AuthedRequest, res: Response): Promise<void> {
  const userId = req.auth!.userId;
  const displayName = String(req.body?.displayName ?? '').trim().slice(0, 50);
  if (!displayName) {
    res.status(400).json({ error: 'Anzeigename erforderlich.' });
    return;
  }
  await pool.query('UPDATE users SET display_name = ? WHERE id = ?', [displayName, userId]);
  const [rows] = await pool.query<UserRow[]>('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  res.json({ user: publicUser(rows[0]) });
}

/** Rooms the authenticated user owns or has a seat in — for the "Meine Räume" list. */
export async function myRooms(req: AuthedRequest, res: Response): Promise<void> {
  const userId = req.auth!.userId;
  interface RoomRow extends RowDataPacket {
    code: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
    is_owner: number;
  }
  const [rows] = await pool.query<RoomRow[]>(
    `SELECT r.code, r.name, r.status, r.created_at, r.updated_at,
            (r.owner_user_id = ?) AS is_owner
       FROM soullink_rooms r
       LEFT JOIN soullink_seats s ON s.room_id = r.id AND s.user_id = ?
      WHERE r.owner_user_id = ? OR s.user_id = ?
      GROUP BY r.id
      ORDER BY r.updated_at DESC
      LIMIT 50`,
    [userId, userId, userId, userId],
  );
  res.json({
    rooms: rows.map(r => ({
      roomCode: r.code,
      name: r.name,
      status: r.status,
      isOwner: Boolean(r.is_owner),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
}
