import { Server } from 'socket.io';
import { RowDataPacket } from 'mysql2';
import { v4 as uuid } from 'uuid';
import pool from '../../db/connection';
import { emitToUser } from '../../ws/userRegistry';

export interface NotificationRow extends RowDataPacket {
  id: string;
  user_id: string;
  type: string;
  payload: unknown;
  read_at: string | null;
  created_at: string;
}

function serialize(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    read: row.read_at !== null,
    createdAt: row.created_at,
  };
}

/**
 * Persists a notification and pushes it live to the user if they are online.
 * Shared helper used by the friends + room-invite flows.
 */
export async function createNotification(
  io: Server,
  userId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = uuid();
  await pool.query(
    'INSERT INTO notifications (id, user_id, type, payload) VALUES (?, ?, ?, ?)',
    [id, userId, type, JSON.stringify(payload)],
  );
  emitToUser(io, userId, 'notification:new', {
    id,
    type,
    payload,
    read: false,
    createdAt: new Date().toISOString(),
  });
}
