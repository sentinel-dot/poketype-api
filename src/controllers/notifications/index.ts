import { Response } from 'express';
import pool from '../../db/connection';
import { AuthedRequest } from '../../middleware/auth';
import { NotificationRow } from './service';

export async function listNotifications(req: AuthedRequest, res: Response): Promise<void> {
  const userId = req.auth!.userId;
  const [rows] = await pool.query<NotificationRow[]>(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [userId],
  );
  const notifications = rows.map(row => ({
    id: row.id,
    type: row.type,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    read: row.read_at !== null,
    createdAt: row.created_at,
  }));
  const unread = notifications.filter(n => !n.read).length;
  res.json({ notifications, unread });
}

export async function markRead(req: AuthedRequest, res: Response): Promise<void> {
  const userId = req.auth!.userId;
  const id = String(req.params.id);
  await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND read_at IS NULL',
    [id, userId],
  );
  res.json({ ok: true });
}

export async function markAllRead(req: AuthedRequest, res: Response): Promise<void> {
  const userId = req.auth!.userId;
  await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
    [userId],
  );
  res.json({ ok: true });
}
