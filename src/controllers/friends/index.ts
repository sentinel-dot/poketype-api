import { Response } from 'express';
import { Server } from 'socket.io';
import { RowDataPacket } from 'mysql2';
import { v4 as uuid } from 'uuid';
import pool from '../../db/connection';
import { AuthedRequest } from '../../middleware/auth';
import { createNotification } from '../notifications/service';

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  display_name: string;
  avatar: string | null;
}

interface FriendRow extends RowDataPacket {
  id: string;
  user_id: string;
  friend_id: string;
  status: 'pending' | 'accepted';
  username: string;
  display_name: string;
  avatar: string | null;
}

/** GET /friends/search?q= — find users by username / display name (excludes self). */
export async function searchUsers(req: AuthedRequest, res: Response): Promise<void> {
  const me = req.auth!.userId;
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) {
    res.json({ users: [] });
    return;
  }
  const like = `%${q}%`;
  const [rows] = await pool.query<UserRow[]>(
    `SELECT id, username, display_name, avatar
       FROM users
      WHERE id <> ? AND (username LIKE ? OR display_name LIKE ?)
      ORDER BY username ASC
      LIMIT 20`,
    [me, like, like],
  );
  res.json({
    users: rows.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar })),
  });
}

/** GET /friends — accepted friends + incoming/outgoing pending requests. */
export async function listFriends(req: AuthedRequest, res: Response): Promise<void> {
  const me = req.auth!.userId;

  const [accepted] = await pool.query<FriendRow[]>(
    `SELECT f.id, f.user_id, f.friend_id, f.status,
            u.username, u.display_name, u.avatar
       FROM friendships f
       JOIN users u ON u.id = IF(f.user_id = ?, f.friend_id, f.user_id)
      WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
      ORDER BY u.username ASC`,
    [me, me, me],
  );

  const [incoming] = await pool.query<FriendRow[]>(
    `SELECT f.id, f.user_id, f.friend_id, f.status,
            u.username, u.display_name, u.avatar
       FROM friendships f
       JOIN users u ON u.id = f.user_id
      WHERE f.friend_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC`,
    [me],
  );

  const [outgoing] = await pool.query<FriendRow[]>(
    `SELECT f.id, f.user_id, f.friend_id, f.status,
            u.username, u.display_name, u.avatar
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ? AND f.status = 'pending'
      ORDER BY f.created_at DESC`,
    [me],
  );

  const map = (r: FriendRow) => ({
    requestId: r.id,
    id: r.user_id === me ? r.friend_id : r.user_id,
    username: r.username,
    displayName: r.display_name,
    avatar: r.avatar,
  });

  res.json({
    friends: accepted.map(map),
    incoming: incoming.map(map),
    outgoing: outgoing.map(map),
  });
}

/** POST /friends/request { userId } — send a friend request. */
export async function sendRequest(io: Server, req: AuthedRequest, res: Response): Promise<void> {
  const me = req.auth!.userId;
  const targetId = String(req.body?.userId ?? '').trim();

  if (!targetId || targetId === me) {
    res.status(400).json({ error: 'Ungültiger Nutzer.' });
    return;
  }

  const [users] = await pool.query<UserRow[]>('SELECT id, username, display_name FROM users WHERE id = ? LIMIT 1', [targetId]);
  if (users.length === 0) {
    res.status(404).json({ error: 'Nutzer nicht gefunden.' });
    return;
  }

  // Already friends or a request exists in either direction?
  const [existing] = await pool.query<FriendRow[]>(
    `SELECT id, user_id, friend_id, status FROM friendships
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
      LIMIT 1`,
    [me, targetId, targetId, me],
  );
  if (existing.length > 0) {
    const row = existing[0];
    if (row.status === 'accepted') {
      res.status(409).json({ error: 'Ihr seid bereits befreundet.' });
      return;
    }
    // Incoming request from target → accept it instead of duplicating.
    if (row.friend_id === me) {
      await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = ?", [row.id]);
      const [meRow] = await pool.query<UserRow[]>('SELECT username, display_name FROM users WHERE id = ?', [me]);
      await createNotification(io, targetId, 'friend_accepted', {
        userId: me,
        username: meRow[0]?.username,
        displayName: meRow[0]?.display_name,
      });
      res.json({ ok: true, status: 'accepted' });
      return;
    }
    res.status(409).json({ error: 'Anfrage bereits gesendet.' });
    return;
  }

  const id = uuid();
  await pool.query(
    "INSERT INTO friendships (id, user_id, friend_id, status) VALUES (?, ?, ?, 'pending')",
    [id, me, targetId],
  );

  const [meRow] = await pool.query<UserRow[]>('SELECT username, display_name FROM users WHERE id = ?', [me]);
  await createNotification(io, targetId, 'friend_request', {
    requestId: id,
    userId: me,
    username: meRow[0]?.username,
    displayName: meRow[0]?.display_name,
  });

  res.status(201).json({ ok: true, status: 'pending' });
}

/** POST /friends/accept { requestId | userId } */
export async function acceptRequest(io: Server, req: AuthedRequest, res: Response): Promise<void> {
  const me = req.auth!.userId;
  const requestId = String(req.body?.requestId ?? '').trim();
  const userId = String(req.body?.userId ?? '').trim();

  const [rows] = requestId
    ? await pool.query<FriendRow[]>(
        "SELECT id, user_id, friend_id FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending' LIMIT 1",
        [requestId, me],
      )
    : await pool.query<FriendRow[]>(
        "SELECT id, user_id, friend_id FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending' LIMIT 1",
        [userId, me],
      );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Anfrage nicht gefunden.' });
    return;
  }

  await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = ?", [rows[0].id]);
  const [meRow] = await pool.query<UserRow[]>('SELECT username, display_name FROM users WHERE id = ?', [me]);
  await createNotification(io, rows[0].user_id, 'friend_accepted', {
    userId: me,
    username: meRow[0]?.username,
    displayName: meRow[0]?.display_name,
  });

  res.json({ ok: true });
}

/** POST /friends/decline { requestId | userId } — reject an incoming request. */
export async function declineRequest(req: AuthedRequest, res: Response): Promise<void> {
  const me = req.auth!.userId;
  const requestId = String(req.body?.requestId ?? '').trim();
  const userId = String(req.body?.userId ?? '').trim();
  if (requestId) {
    await pool.query(
      "DELETE FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'",
      [requestId, me],
    );
  } else {
    await pool.query(
      "DELETE FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending'",
      [userId, me],
    );
  }
  res.json({ ok: true });
}

/** DELETE /friends/:userId — remove a friend (either direction). */
export async function removeFriend(req: AuthedRequest, res: Response): Promise<void> {
  const me = req.auth!.userId;
  const otherId = String(req.params.userId);
  await pool.query(
    `DELETE FROM friendships
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    [me, otherId, otherId, me],
  );
  res.json({ ok: true });
}
