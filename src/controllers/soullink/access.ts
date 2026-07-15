import { RowDataPacket } from 'mysql2';
import pool from '../../db/connection';

interface AccessRow extends RowDataPacket {
  room_id: string;
  participant_token: string | null;
  owner_user_id: string | null;
}

/**
 * Resolves write access to a seat. A caller may write when they either hold the
 * seat's participantToken OR are the authenticated room owner (admin control).
 * Returns the room_id on success, or null when the seat is unknown / access is
 * denied.
 */
export async function resolveSeatWriteAccess(
  roomCode: string,
  seatId: string,
  participantToken?: string | null,
  authUserId?: string | null,
): Promise<string | null> {
  const [rows] = await pool.query<AccessRow[]>(
    `SELECT s.room_id, s.participant_token, r.owner_user_id
       FROM soullink_seats s
       JOIN soullink_rooms r ON r.id = s.room_id
      WHERE r.code = ? AND s.id = ?
      LIMIT 1`,
    [roomCode, seatId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const tokenMatch =
    typeof participantToken === 'string' &&
    participantToken.length > 0 &&
    row.participant_token === participantToken;
  const isOwner = !!authUserId && !!row.owner_user_id && row.owner_user_id === authUserId;

  return tokenMatch || isOwner ? row.room_id : null;
}
